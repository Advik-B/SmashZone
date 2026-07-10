// Client-side "game feel" tunables. Every satisfaction knob — shake, hitstop,
// FOV kicks, combo timing, haptic patterns — lives here so taste passes are a
// one-file edit. Presentation only: nothing here feeds the deterministic sim.

import { isTouchDevice } from "./input";

export const JUICE = {
  shake: {
    takenLight: 0.18,
    takenHeavy: 0.35,
    takenPerDamage: 0.006,
    takenMax: 0.55,
    dealtBase: 0.1,
    dealtPerDamage: 0.003,
    slam: 0.2,
    explosion: 0.3,
    ko: 0.5,
  },
  // Hitstop must stay under ~85 ms: the sim catch-up loop caps at 6 ticks
  // (~100 ms) per frame and resets the accumulator past that, which reads as
  // a prediction snap.
  hitstop: {
    lightMs: 45,
    heavyBaseMs: 70,
    heavyPerDamage: 0.4,
    maxMs: 85,
    koMs: 80,
  },
  fov: {
    base: 60,
    max: 8, // additive kick clamp, degrees
    decayPerSec: 14,
    dealtHeavy: -3, // punch IN when my heavy lands
    takenHeavy: 2.5,
    explosion: 4,
    ko: 5,
    dash: -1.5,
  },
  combo: {
    windowMs: 2500,
    minShow: 2,
    pitchStep: 0.03,
    pitchMaxSteps: 8,
  },
  floater: {
    scaleBase: 0.9,
    scalePerDamage: 1 / 30,
    scaleMax: 1.7,
    bigDamage: 20, // at/above this the number goes red
    bigColor: "#ff5555",
    koScale: 2.2,
    koColor: "#ff5e7d",
    koLife: 1.0,
  },
  haptics: {
    hitLight: 18,
    hitHeavy: 35,
    dealt: 12,
    death: 90,
    kill: [25, 30, 25],
    win: [40, 60, 40, 60, 120],
  },
} as const;

/** Vibrate on devices that support it; silent no-op everywhere else. */
export function haptic(pattern: number | readonly number[]) {
  if (!isTouchDevice() || !("vibrate" in navigator)) return;
  try {
    navigator.vibrate(typeof pattern === "number" ? pattern : [...pattern]);
  } catch {
    /* some browsers throw on odd patterns; never let feedback break input */
  }
}

/** Random playback-rate multiplier so repeated SFX don't machine-gun. */
export function pitchVar(spread = 0.06): number {
  return 1 + (Math.random() * 2 - 1) * spread;
}
