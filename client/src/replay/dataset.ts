// A parsed, indexed replay. `load` walks the frame log exactly once to build
// tick indices, the event/phase/roster timelines, the recorder's camera track
// and the marker list, then keeps only the raw snapshot bytes plus a small
// decoded-snapshot LRU. Playback re-decodes ~2 snapshots per rendered frame
// through the cache — less decode work than a live client does at 20 Hz —
// so even hour-long replays stay a few MB of raw bytes, never a sea of JS
// objects.
//
// Decode canary: postcard is positional, so bytes from a different build can
// "decode" into garbage without erroring. Snapshots must echo the tick their
// frame was stamped with, ticks must be monotonic, and player ids must be
// sane — any miss fails the load with a version error (header.buildId is the
// advisory layer on top).

import { decode_server_msg } from "../wasm/pkg/sim_wasm";
import constants from "../../../shared/constants.json";
import type {
  GameEvent,
  Phase,
  PlayerMeta,
  ServerMsg,
  Snapshot,
} from "../net/messages";
import { lerpAngle } from "../game/interp";
import {
  FK_CAM,
  FK_MSG,
  FK_ROSTER,
  TimelineBuilder,
  decodeCamPayload,
  decodeRosterPayload,
  readContainer,
  type RawFrame,
  type ReplayHeader,
  type ReplayMarker,
  type ReplayResult,
  type ReplayRoundInfo,
} from "./format";

/** Snapshot spacing above this many ticks is a recording gap (reconnect). */
export const GAP_TICKS = 60;

const SNAPSHOT_CACHE_CAP = 64;

export interface TimedEvent {
  tick: number;
  ev: GameEvent;
}

type RosterOp =
  | { tick: number; type: "reset"; players: PlayerMeta[] }
  | { tick: number; type: "join"; meta: PlayerMeta }
  | { tick: number; type: "leave"; id: number };

function versionError(): Error {
  return new Error(
    "this replay was recorded on a different game version and can't be decoded",
  );
}

export class ReplayDataset {
  readonly header: ReplayHeader;
  /** Playable range: the first/last snapshot tick in the log. */
  readonly startTick: number;
  readonly endTick: number;
  readonly rounds: ReplayRoundInfo[];
  readonly markers: ReplayMarker[];
  readonly result: ReplayResult | null;
  /** Snapshot events in tick order (ties keep log order). */
  readonly events: TimedEvent[];
  /** Recording gaps (reconnect outages) for the timeline. */
  readonly gaps: { from: number; to: number }[];

  private snapTicks: Uint32Array;
  private snapPayloads: Uint8Array[];
  private snapCache = new Map<number, Snapshot>();
  private phases: { tick: number; phase: Phase }[];
  private rosterStates: { tick: number; players: Map<number, PlayerMeta> }[];
  private camTicks: Uint32Array;
  private camYaw: Float32Array;
  private camPitch: Float32Array;

  private constructor(args: {
    header: ReplayHeader;
    snapTicks: Uint32Array;
    snapPayloads: Uint8Array[];
    phases: { tick: number; phase: Phase }[];
    rosterOps: RosterOp[];
    camTicks: Uint32Array;
    camYaw: Float32Array;
    camPitch: Float32Array;
    timeline: TimelineBuilder;
    events: TimedEvent[];
  }) {
    this.header = args.header;
    this.snapTicks = args.snapTicks;
    this.snapPayloads = args.snapPayloads;
    this.phases = args.phases;
    this.camTicks = args.camTicks;
    this.camYaw = args.camYaw;
    this.camPitch = args.camPitch;
    this.events = args.events;
    this.rounds = args.timeline.rounds;
    this.markers = args.timeline.markers;
    this.result = args.timeline.result;
    this.startTick = args.snapTicks[0];
    this.endTick = args.snapTicks[args.snapTicks.length - 1];

    // Cumulative roster states so rosterAt() is a binary search, not a replay.
    this.rosterStates = [];
    let cur = new Map<number, PlayerMeta>();
    for (const op of args.rosterOps) {
      cur = new Map(cur);
      if (op.type === "reset") {
        cur.clear();
        for (const p of op.players) cur.set(p.id, p);
      } else if (op.type === "join") {
        cur.set(op.meta.id, op.meta);
      } else {
        cur.delete(op.id);
      }
      this.rosterStates.push({ tick: op.tick, players: cur });
    }
    if (this.rosterStates.length === 0) {
      // Defensive: a log should always open with a ROSTER frame.
      const players = new Map(this.header.players.map((p) => [p.id, p]));
      this.rosterStates.push({ tick: 0, players });
    }

    this.gaps = [];
    for (let i = 1; i < this.snapTicks.length; i++) {
      const d = this.snapTicks[i] - this.snapTicks[i - 1];
      if (d > GAP_TICKS) {
        this.gaps.push({ from: this.snapTicks[i - 1], to: this.snapTicks[i] });
      }
    }
  }

  static async load(blob: Blob): Promise<ReplayDataset> {
    const { header, frames } = await readContainer(blob);
    const snapTicks: number[] = [];
    const snapPayloads: Uint8Array[] = [];
    const phases: { tick: number; phase: Phase }[] = [];
    const rosterOps: RosterOp[] = [];
    const camTicks: number[] = [];
    const camYaw: number[] = [];
    const camPitch: number[] = [];
    const events: TimedEvent[] = [];
    const timeline = new TimelineBuilder();

    for (const f of frames) {
      switch (f.kind) {
        case FK_ROSTER: {
          let roster;
          try {
            roster = decodeRosterPayload(f.payload);
          } catch {
            throw new Error("corrupt replay (bad roster frame)");
          }
          rosterOps.push({ tick: f.tick, type: "reset", players: roster.players });
          phases.push({ tick: f.tick, phase: roster.phase });
          timeline.addPhase(roster.phase, f.tick);
          break;
        }
        case FK_CAM: {
          const cam = decodeCamPayload(f.payload);
          camTicks.push(f.tick);
          camYaw.push(cam.yaw);
          camPitch.push(cam.pitch);
          break;
        }
        case FK_MSG: {
          const msg = decode_server_msg(f.payload) as ServerMsg | null;
          if (!msg) throw versionError();
          switch (msg.type) {
            case "Snapshot": {
              const s = msg.snapshot;
              // Canaries: tick echo, monotonic ticks, sane player ids.
              if (
                s.tick !== f.tick ||
                (snapTicks.length > 0 && s.tick <= snapTicks[snapTicks.length - 1]) ||
                s.players.length > constants.maxPlayers ||
                s.players.some((p) => p.id >= 2 * constants.maxPlayers)
              ) {
                throw versionError();
              }
              snapTicks.push(s.tick);
              snapPayloads.push(f.payload);
              for (const ev of s.events) {
                events.push({ tick: s.tick, ev });
                timeline.addEvent(ev, s.tick);
              }
              break;
            }
            case "PhaseChange":
              phases.push({ tick: msg.tick, phase: msg.phase });
              timeline.addPhase(msg.phase, msg.tick);
              break;
            case "PlayerJoined":
              rosterOps.push({
                tick: f.tick,
                type: "join",
                meta: {
                  id: msg.id,
                  name: msg.name,
                  slot: msg.slot,
                  bot: msg.bot,
                  difficulty: msg.difficulty,
                },
              });
              break;
            case "PlayerLeft":
              rosterOps.push({ tick: f.tick, type: "leave", id: msg.id });
              break;
            default:
              throw versionError(); // Welcome/Pong/Error are never in a log
          }
          break;
        }
        default:
          throw new Error("corrupt replay (unknown frame kind)");
      }
    }

    if (snapTicks.length === 0) throw new Error("replay contains no snapshots");

    return new ReplayDataset({
      header,
      snapTicks: Uint32Array.from(snapTicks),
      snapPayloads,
      phases,
      rosterOps,
      camTicks: Uint32Array.from(camTicks),
      camYaw: Float32Array.from(camYaw),
      camPitch: Float32Array.from(camPitch),
      timeline,
      events,
    });
  }

  get snapshotCount(): number {
    return this.snapTicks.length;
  }

  snapshotTick(i: number): number {
    return this.snapTicks[Math.max(0, Math.min(this.snapTicks.length - 1, i))];
  }

  /** Index of the last snapshot with tick <= target (clamped to 0). */
  indexForTick(tick: number): number {
    const ticks = this.snapTicks;
    let lo = 0;
    let hi = ticks.length - 1;
    if (tick <= ticks[0]) return 0;
    if (tick >= ticks[hi]) return hi;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (ticks[mid] <= tick) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Decoded snapshot by index, via a small LRU (playback touches ~2/frame). */
  snapshotAt(i: number): Snapshot {
    const idx = Math.max(0, Math.min(this.snapPayloads.length - 1, i));
    const hit = this.snapCache.get(idx);
    if (hit) {
      // Refresh recency.
      this.snapCache.delete(idx);
      this.snapCache.set(idx, hit);
      return hit;
    }
    const msg = decode_server_msg(this.snapPayloads[idx]) as ServerMsg | null;
    if (!msg || msg.type !== "Snapshot") throw versionError();
    const snap = msg.snapshot;
    this.snapCache.set(idx, snap);
    if (this.snapCache.size > SNAPSHOT_CACHE_CAP) {
      this.snapCache.delete(this.snapCache.keys().next().value!);
    }
    return snap;
  }

  /** Phase in effect at a tick (the last phase change at or before it). */
  phaseAt(tick: number): Phase {
    let out = this.phases[0]?.phase ?? { type: "Lobby" as const, host: 0 };
    for (const p of this.phases) {
      if (p.tick > tick) break;
      out = p.phase;
    }
    return out;
  }

  /** Every player who appears anywhere in the replay (union of roster states). */
  allPlayers(): PlayerMeta[] {
    const all = new Map<number, PlayerMeta>();
    for (const s of this.rosterStates) {
      for (const [id, m] of s.players) if (!all.has(id)) all.set(id, m);
    }
    return [...all.values()].sort((x, y) => x.id - y.id);
  }

  /** Roster in effect at a tick. The returned map is shared — don't mutate. */
  rosterAt(tick: number): Map<number, PlayerMeta> {
    const states = this.rosterStates;
    let out = states[0].players;
    for (const s of states) {
      if (s.tick > tick) break;
      out = s.players;
    }
    return out;
  }

  /**
   * The round segment governing a tick: the last one that started at or
   * before it. A round keeps governing through the round-end pause (the
   * arena must hold its end-of-round holes, like live play) until the next
   * round's countdown takes over.
   */
  roundAt(tick: number): ReplayRoundInfo | null {
    let out: ReplayRoundInfo | null = null;
    for (const r of this.rounds) {
      const start = r.countdownTick ?? r.roundStartTick;
      if (start === null) continue;
      if (start > tick) break; // rounds are chronological
      out = r;
    }
    return out;
  }

  /** The recorder's own camera at a tick (yaw/pitch, lerped between samples). */
  camAt(tick: number): { yaw: number; pitch: number } {
    const ticks = this.camTicks;
    const n = ticks.length;
    if (n === 0) return { yaw: 0, pitch: -0.5 };
    if (tick <= ticks[0]) return { yaw: this.camYaw[0], pitch: this.camPitch[0] };
    if (tick >= ticks[n - 1]) {
      return { yaw: this.camYaw[n - 1], pitch: this.camPitch[n - 1] };
    }
    let lo = 0;
    let hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (ticks[mid] <= tick) lo = mid;
      else hi = mid;
    }
    const t = (tick - ticks[lo]) / Math.max(1, ticks[hi] - ticks[lo]);
    return {
      yaw: lerpAngle(this.camYaw[lo], this.camYaw[hi], t),
      pitch: this.camPitch[lo] + (this.camPitch[hi] - this.camPitch[lo]) * t,
    };
  }

  /** First event index strictly after `tick` (event-cursor seek position). */
  eventIndexAfter(tick: number): number {
    const evs = this.events;
    let lo = 0;
    let hi = evs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (evs[mid].tick <= tick) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

/** Raw frames re-exported for tooling/tests. */
export type { RawFrame };
