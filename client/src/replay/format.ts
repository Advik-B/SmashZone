// The .szr replay container. Layout:
//
//   bytes 0..4    ASCII magic "SZR1"
//   bytes 4..8    u32 LE header length
//   bytes 8..8+N  header JSON (UTF-8, uncompressed so the library can list
//                 replays without inflating the log)
//   rest          frame log, gzipped via CompressionStream when available
//
// Frame log = repeated frames, little-endian:
//
//   u8  kind      1 = MSG (raw postcard ServerMsg bytes, exactly as received)
//                 2 = CAM (f32 camYaw, f32 camPitch — the recorder's own
//                     camera, one per snapshot, for exact POV playback)
//                 3 = ROSTER (UTF-8 JSON { players, phase } at record start
//                     and on every reconnect re-Welcome)
//   u32 tick      server tick the frame belongs to
//   u32 len       payload byte length
//   u8[len]       payload
//
// MSG frames only ever hold Snapshot / PhaseChange / PlayerJoined /
// PlayerLeft. Welcome is never persisted — it carries the session token —
// which is why the roster travels in ROSTER frames instead.
//
// Versioning: postcard is positional with no protocol version constant, so
// raw bytes are only guaranteed decodable by the build that wrote them. The
// header records `buildId` (advisory warning on mismatch); the hard gate is
// the decode canary in dataset.ts.

import type { GameEvent, Phase, PlayerMeta } from "../net/messages";
import { PU_BOMB } from "../net/messages";

export const SZR_MAGIC = "SZR1";
export const SZR_VERSION = 1;

export const FK_MSG = 1;
export const FK_CAM = 2;
export const FK_ROSTER = 3;

/** Vite-injected build identity; "dev" outside real builds. */
export const BUILD_ID: string =
  typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";

export interface RawFrame {
  kind: number;
  tick: number;
  payload: Uint8Array;
}

export interface ReplayRoundInfo {
  round: number;
  /** Tick of the Countdown phase change; null when we joined mid-round. */
  countdownTick: number | null;
  /** The round's tick origin (arena shrink is a pure function of it). */
  roundStartTick: number | null;
  /** Tick of the RoundEnd/MatchEnd that closed the round; null if cut off. */
  endTick: number | null;
  winner: number | null;
}

export type MarkerKind = "ko" | "hit" | "pickup" | "boom";

export interface ReplayMarker {
  tick: number;
  kind: MarkerKind;
  /** Primary actor: ko = victim, hit = attacker, pickup = player; -1 none. */
  player: number;
  /** Secondary actor: ko = killer, hit = target; -1 none. */
  other: number;
  /** Extra: hit = damage, pickup = powerup kind; 0 otherwise. */
  data: number;
}

export interface ReplayResult {
  winner: number;
  scores: { id: number; wins: number }[];
}

export interface ReplayHeader {
  format: "szr";
  version: number;
  buildId: string;
  createdAt: string;
  code: string;
  localPlayerId: number;
  /** Roster at record start (ROSTER frames carry later resets). */
  players: PlayerMeta[];
  startTick: number;
  endTick: number;
  tickRate: number;
  snapshotDivisor: number;
  /** Finalized before MatchEnd (left mid-match, disconnect, …). */
  partial: boolean;
  joinedMidMatch: boolean;
  compression: "gzip" | "none";
  result: ReplayResult | null;
  /** Display cache — dataset.ts recomputes from the log and wins. */
  rounds: ReplayRoundInfo[];
  markers: ReplayMarker[];
}

// ---------------------------------------------------------------------------
// Frame log encode/decode

const FRAME_HEAD = 9; // u8 kind + u32 tick + u32 len

export function encodeFrames(frames: RawFrame[]): Uint8Array {
  let total = 0;
  for (const f of frames) total += FRAME_HEAD + f.payload.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const f of frames) {
    dv.setUint8(o, f.kind);
    dv.setUint32(o + 1, f.tick, true);
    dv.setUint32(o + 5, f.payload.length, true);
    out.set(f.payload, o + FRAME_HEAD);
    o += FRAME_HEAD + f.payload.length;
  }
  return out;
}

export function decodeFrames(bytes: Uint8Array): RawFrame[] {
  const frames: RawFrame[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  while (o + FRAME_HEAD <= bytes.length) {
    const kind = dv.getUint8(o);
    const tick = dv.getUint32(o + 1, true);
    const len = dv.getUint32(o + 5, true);
    if (o + FRAME_HEAD + len > bytes.length) {
      throw new Error("truncated replay frame log");
    }
    frames.push({
      kind,
      tick,
      payload: bytes.subarray(o + FRAME_HEAD, o + FRAME_HEAD + len),
    });
    o += FRAME_HEAD + len;
  }
  if (o !== bytes.length) throw new Error("trailing bytes in replay frame log");
  return frames;
}

export function encodeCamPayload(yaw: number, pitch: number): Uint8Array {
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  dv.setFloat32(0, yaw, true);
  dv.setFloat32(4, pitch, true);
  return out;
}

export function decodeCamPayload(payload: Uint8Array): { yaw: number; pitch: number } {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { yaw: dv.getFloat32(0, true), pitch: dv.getFloat32(4, true) };
}

export interface RosterPayload {
  players: PlayerMeta[];
  phase: Phase;
}

export function encodeRosterPayload(r: RosterPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(r));
}

export function decodeRosterPayload(payload: Uint8Array): RosterPayload {
  return JSON.parse(new TextDecoder().decode(payload)) as RosterPayload;
}

// ---------------------------------------------------------------------------
// Container read/write

const hasCompressionStream = typeof CompressionStream !== "undefined";

async function streamThrough(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  // lib.dom types CompressionStream's writable as BufferSource, which TS won't
  // unify with Blob.stream()'s Uint8Array chunks; runtime-wise they match.
  const pair = transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(pair);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function writeContainer(
  header: ReplayHeader,
  frameBytes: Uint8Array,
): Promise<Blob> {
  const body = hasCompressionStream
    ? await streamThrough(frameBytes, new CompressionStream("gzip"))
    : frameBytes;
  header.compression = hasCompressionStream ? "gzip" : "none";
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const head = new Uint8Array(8);
  head.set([0x53, 0x5a, 0x52, 0x31]); // "SZR1"
  new DataView(head.buffer).setUint32(4, headerBytes.length, true);
  return new Blob([head, headerBytes, body as BlobPart], {
    type: "application/octet-stream",
  });
}

export async function readHeader(blob: Blob): Promise<ReplayHeader> {
  if (blob.size < 8) throw new Error("not a SmashZone replay (too small)");
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (new TextDecoder().decode(head.subarray(0, 4)) !== SZR_MAGIC) {
    throw new Error("not a SmashZone replay (bad magic)");
  }
  const headerLen = new DataView(head.buffer).getUint32(4, true);
  if (headerLen === 0 || 8 + headerLen > blob.size) {
    throw new Error("corrupt replay header");
  }
  const json = await blob.slice(8, 8 + headerLen).text();
  let header: ReplayHeader;
  try {
    header = JSON.parse(json) as ReplayHeader;
  } catch {
    throw new Error("corrupt replay header");
  }
  if (header.format !== "szr") throw new Error("not a SmashZone replay");
  if (header.version !== SZR_VERSION) {
    throw new Error(`unsupported replay version ${header.version}`);
  }
  return header;
}

export async function readContainer(
  blob: Blob,
): Promise<{ header: ReplayHeader; frames: RawFrame[] }> {
  const header = await readHeader(blob);
  const headerLen = new DataView(
    new Uint8Array(await blob.slice(4, 8).arrayBuffer()).buffer,
  ).getUint32(0, true);
  const bodyBlob = blob.slice(8 + headerLen);
  let body: Uint8Array = new Uint8Array(await bodyBlob.arrayBuffer());
  if (header.compression === "gzip") {
    if (!("DecompressionStream" in globalThis)) {
      throw new Error("this browser cannot decompress replays");
    }
    body = await streamThrough(body, new DecompressionStream("gzip"));
  }
  return { header, frames: decodeFrames(body) };
}

// ---------------------------------------------------------------------------
// Timeline (rounds + markers) — shared by the recorder (incremental, for the
// header display cache) and dataset.ts (batch recompute, authoritative).

/** Kill credit window, in ticks (mirrors the live 5 s / performance.now rule). */
const KO_CREDIT_TICKS = 300;
/** Light hits below this damage don't get a timeline marker (clutter). */
const HIT_MARKER_MIN_DAMAGE = 15;

export class TimelineBuilder {
  rounds: ReplayRoundInfo[] = [];
  markers: ReplayMarker[] = [];
  result: ReplayResult | null = null;
  private lastHitBy = new Map<number, { attacker: number; tick: number }>();

  private open(): ReplayRoundInfo | null {
    const last = this.rounds[this.rounds.length - 1];
    return last && last.endTick === null ? last : null;
  }

  addPhase(phase: Phase, tick: number): void {
    switch (phase.type) {
      case "Countdown": {
        if (this.open()?.round !== phase.round) {
          this.rounds.push({
            round: phase.round,
            countdownTick: tick,
            roundStartTick: null,
            endTick: null,
            winner: null,
          });
        }
        break;
      }
      case "Playing": {
        let cur = this.open();
        if (!cur || cur.round !== phase.round) {
          cur = {
            round: phase.round,
            countdownTick: null, // joined/started recording mid-round
            roundStartTick: null,
            endTick: null,
            winner: null,
          };
          this.rounds.push(cur);
        }
        cur.roundStartTick = phase.roundStartTick;
        break;
      }
      case "RoundEnd": {
        const cur = this.open();
        if (cur) {
          cur.endTick = tick;
          cur.winner = phase.winner;
        }
        this.lastHitBy.clear();
        break;
      }
      case "MatchEnd": {
        const cur = this.open();
        if (cur) {
          cur.endTick = tick;
          cur.winner = phase.winner;
        }
        this.result = {
          winner: phase.winner,
          scores: phase.scores.map((s) => ({ id: s.id, wins: s.wins })),
        };
        this.lastHitBy.clear();
        break;
      }
      case "Lobby":
        break;
    }
  }

  addEvent(ev: GameEvent, tick: number): void {
    switch (ev.type) {
      case "Hit": {
        this.lastHitBy.set(ev.target, { attacker: ev.attacker, tick });
        if (ev.heavy || ev.damage >= HIT_MARKER_MIN_DAMAGE) {
          this.markers.push({
            tick,
            kind: "hit",
            player: ev.attacker,
            other: ev.target,
            data: ev.damage,
          });
        }
        break;
      }
      case "Death": {
        const credit = this.lastHitBy.get(ev.player);
        const killer =
          credit &&
          tick - credit.tick <= KO_CREDIT_TICKS &&
          credit.attacker !== ev.player
            ? credit.attacker
            : -1;
        this.lastHitBy.delete(ev.player);
        this.markers.push({ tick, kind: "ko", player: ev.player, other: killer, data: 0 });
        break;
      }
      case "PickupTaken":
        this.markers.push({
          tick,
          kind: "pickup",
          player: ev.player,
          other: -1,
          data: ev.kind,
        });
        break;
      case "Explosion":
        if (ev.kind === PU_BOMB) {
          this.markers.push({ tick, kind: "boom", player: -1, other: -1, data: 0 });
        }
        break;
      default:
        break;
    }
  }
}
