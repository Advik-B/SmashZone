import { isTouchDevice } from "./input";

export type Quality = "low" | "medium" | "high";

export interface QualityPreset {
  dprCap: number;
  shadows: boolean;
  shadowRes: number;
  bloom: boolean;
  particleBudget: number;
}

export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  low: { dprCap: 1, shadows: false, shadowRes: 0, bloom: false, particleBudget: 120 },
  medium: { dprCap: 1.5, shadows: true, shadowRes: 1024, bloom: true, particleBudget: 240 },
  high: { dprCap: 2, shadows: true, shadowRes: 2048, bloom: true, particleBudget: 320 },
};

const KEY = "sz-quality";

/** Saved preset, defaulting to low on touch devices and high on desktop. */
export function savedQuality(): Quality {
  const q = localStorage.getItem(KEY);
  if (q === "low" || q === "medium" || q === "high") return q;
  return isTouchDevice() ? "low" : "high";
}

export function saveQuality(q: Quality) {
  localStorage.setItem(KEY, q);
}
