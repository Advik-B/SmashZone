// Entity-interpolation helpers shared by the live client (gameclient.ts) and
// replay playback: both render remote entities by sampling a chronological
// buffer of authoritative snapshot states at a fractional tick.

import type { Vec3 } from "../net/messages";

/** One player's state from a snapshot, keyed by the snapshot tick. */
export interface RemoteSample {
  tick: number;
  pos: Vec3;
  yaw: number;
  anim: number;
  alive: boolean;
  powerup: number;
  intangible: boolean;
  grounded: boolean;
}

/** Shortest-arc angle lerp (yaw wraps at 2π). */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/**
 * Interpolated state at `tick` from a chronological sample buffer: lerps
 * position/yaw between the bracketing samples and latches the discrete fields
 * (anim, alive, …) from the later one. Clamps at the buffer edges.
 */
export function sampleBuffer(buf: RemoteSample[], tick: number): RemoteSample | null {
  if (buf.length === 0) return null;
  if (tick <= buf[0].tick) return buf[0];
  const last = buf[buf.length - 1];
  if (tick >= last.tick) return last;
  for (let i = buf.length - 2; i >= 0; i--) {
    const a = buf[i];
    const b = buf[i + 1];
    if (a.tick <= tick && tick <= b.tick) {
      const t = (tick - a.tick) / Math.max(1, b.tick - a.tick);
      return {
        tick,
        pos: lerpVec3(a.pos, b.pos, t),
        yaw: lerpAngle(a.yaw, b.yaw, t),
        anim: b.anim,
        alive: b.alive,
        powerup: b.powerup,
        intangible: b.intangible,
        grounded: b.grounded,
      };
    }
  }
  return last;
}
