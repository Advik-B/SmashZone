// In-memory match recorder. GameClient owns one and tees every decoded
// server message into it via Connection.onRaw; the recorder keeps the raw
// wire bytes of the world-relevant messages (Snapshot / PhaseChange /
// PlayerJoined / PlayerLeft), a 20 Hz camera track, and ROSTER frames, then
// packages them into a .szr container at finalize.
//
// Memory: ~200 B per snapshot at 20 Hz ≈ 250 KB/min — a long match is a few
// megabytes, held only until finalize.

import constants from "../../../shared/constants.json";
import type { PlayerMeta, Phase, ServerMsg } from "../net/messages";
import {
  BUILD_ID,
  FK_CAM,
  FK_MSG,
  FK_ROSTER,
  SZR_VERSION,
  TimelineBuilder,
  encodeCamPayload,
  encodeFrames,
  encodeRosterPayload,
  writeContainer,
  type RawFrame,
  type ReplayHeader,
} from "./format";
import { saveReplay } from "./store";

const RECORD_PREF_KEY = "sz-record";

export function recordingEnabled(): boolean {
  return localStorage.getItem(RECORD_PREF_KEY) !== "0";
}

export function setRecordingEnabled(on: boolean): void {
  localStorage.setItem(RECORD_PREF_KEY, on ? "1" : "0");
}

export type FinalizeReason = "match-end" | "exit" | "disconnect";

export interface RecorderBeginCtx {
  code: string;
  localPlayerId: number;
  players: PlayerMeta[];
  phase: Phase;
  tick: number;
  joinedMidMatch: boolean;
}

export interface FinalizedReplay {
  id: string | null; // null = persisting failed (quota, private mode)
  header: ReplayHeader;
  blob: Blob; // kept so callers can offer a direct download when id is null
}

export class ReplayRecorder {
  private frames: RawFrame[] = [];
  private timeline = new TimelineBuilder();
  private recording = false;
  private beginCtx: RecorderBeginCtx | null = null;
  private lastTick = 0;

  constructor(private getCam: () => { yaw: number; pitch: number }) {}

  get active(): boolean {
    return this.recording;
  }

  /** Start recording. No-op while a recording is already running. */
  begin(ctx: RecorderBeginCtx): void {
    if (this.recording || !recordingEnabled()) return;
    this.recording = true;
    this.frames = [];
    this.timeline = new TimelineBuilder();
    this.beginCtx = { ...ctx, players: ctx.players.map((p) => ({ ...p })) };
    this.lastTick = ctx.tick;
    this.pushRoster(ctx.players, ctx.phase, ctx.tick);
    this.timeline.addPhase(ctx.phase, ctx.tick);
  }

  /** Tee for Connection.onRaw. Copies the bytes it keeps. */
  onServerMsg(raw: Uint8Array, msg: ServerMsg): void {
    if (!this.recording) return;
    switch (msg.type) {
      case "Snapshot": {
        const tick = msg.snapshot.tick;
        this.lastTick = tick;
        this.frames.push({ kind: FK_MSG, tick, payload: raw.slice() });
        const cam = this.getCam();
        this.frames.push({
          kind: FK_CAM,
          tick,
          payload: encodeCamPayload(cam.yaw, cam.pitch),
        });
        for (const ev of msg.snapshot.events) this.timeline.addEvent(ev, tick);
        break;
      }
      case "PhaseChange": {
        this.lastTick = msg.tick;
        this.frames.push({ kind: FK_MSG, tick: msg.tick, payload: raw.slice() });
        this.timeline.addPhase(msg.phase, msg.tick);
        break;
      }
      case "PlayerJoined":
      case "PlayerLeft": {
        this.frames.push({ kind: FK_MSG, tick: this.lastTick, payload: raw.slice() });
        break;
      }
      default:
        break; // Welcome (session token!), Pong, Error: never persisted
    }
  }

  /** Reconnect re-Welcome: record the fresh roster + phase, keep recording. */
  rosterReset(players: PlayerMeta[], phase: Phase, tick: number): void {
    if (!this.recording) return;
    this.lastTick = tick;
    this.pushRoster(players, phase, tick);
    this.timeline.addPhase(phase, tick);
  }

  /**
   * Stop and package the recording. Returns null for recordings too short to
   * matter (fewer than ~2 s of snapshots). Persisting failure still returns
   * the built container so the caller can offer a direct download.
   */
  async finalize(reason: FinalizeReason): Promise<FinalizedReplay | null> {
    if (!this.recording || !this.beginCtx) return null;
    this.recording = false;
    const ctx = this.beginCtx;
    this.beginCtx = null;
    const frames = this.frames;
    this.frames = [];

    const snapshots = frames.filter((f) => f.kind === FK_CAM).length; // 1 per snapshot
    if (snapshots < 40) return null; // < ~2 s of match — not worth keeping

    const header: ReplayHeader = {
      format: "szr",
      version: SZR_VERSION,
      buildId: BUILD_ID,
      createdAt: new Date().toISOString(),
      code: ctx.code,
      localPlayerId: ctx.localPlayerId,
      players: ctx.players,
      startTick: ctx.tick,
      endTick: this.lastTick,
      tickRate: constants.tickRate,
      snapshotDivisor: constants.snapshotDivisor,
      partial: reason !== "match-end" || this.timeline.result === null,
      joinedMidMatch: ctx.joinedMidMatch,
      compression: "gzip", // corrected by writeContainer when unavailable
      result: this.timeline.result,
      rounds: this.timeline.rounds,
      markers: this.timeline.markers,
    };
    const blob = await writeContainer(header, encodeFrames(frames));
    let id: string | null = null;
    try {
      id = await saveReplay(header, blob);
    } catch {
      id = null; // quota/private mode — caller may offer the blob directly
    }
    return { id, header, blob };
  }

  discard(): void {
    this.recording = false;
    this.beginCtx = null;
    this.frames = [];
  }

  private pushRoster(players: PlayerMeta[], phase: Phase, tick: number): void {
    this.frames.push({
      kind: FK_ROSTER,
      tick,
      payload: encodeRosterPayload({ players, phase }),
    });
  }
}
