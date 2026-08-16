/**
 * Fullscreen — the experience the PWA exists for.
 *
 * The manifest's `display: "fullscreen"` only applies when the game is launched
 * from an installed icon, so everyone playing in a browser tab needs the
 * Fullscreen API instead.  On phones it also carries the landscape lock: the
 * on-screen thumbstick and action buttons are laid out for a wide screen.
 *
 * Entering fullscreen requires transient user activation, so `enter()` must be
 * called straight from a click/tap handler — before any `await`, or the browser
 * rejects it.
 */
import { isTouchDevice } from "./input";

const KEY = "sz-fullscreen";

/** Safari (and iPadOS) still ship only the webkit-prefixed API. */
interface PrefixedDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
}
interface PrefixedElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

/** `lock`/`unlock` are Android-only and missing from lib.dom's ScreenOrientation. */
interface LockableOrientation {
  lock?: (orientation: "landscape") => Promise<void>;
  unlock?: () => void;
}

const doc = () => document as PrefixedDocument;
const orientation = () =>
  screen.orientation as unknown as LockableOrientation | undefined;

/** False on iPhone Safari, which has no Fullscreen API at all — only install. */
export function fullscreenSupported(): boolean {
  const d = doc();
  return Boolean(d.fullscreenEnabled ?? d.webkitFullscreenEnabled);
}

export function isFullscreen(): boolean {
  const d = doc();
  return (d.fullscreenElement ?? d.webkitFullscreenElement) != null;
}

/**
 * Saved preference: whether starting a match should go fullscreen by itself.
 * On by default — a party brawler wants the whole screen, and the toggle (menu
 * button / settings) is one tap away for anyone who disagrees.
 */
export function fullscreenPreferred(): boolean {
  return localStorage.getItem(KEY) !== "0";
}

export function setFullscreenPreferred(on: boolean): void {
  localStorage.setItem(KEY, on ? "1" : "0");
}

/**
 * Phones only, and only while fullscreen: Android requires fullscreen before a
 * lock is allowed, and it throws outright on desktop. Failure is fine — the
 * game plays in portrait, it just wastes screen.
 */
async function lockLandscape(): Promise<void> {
  if (!isTouchDevice()) return;
  try {
    await orientation()?.lock?.("landscape");
  } catch {
    /* unsupported (desktop, iOS) or refused — not worth surfacing */
  }
}

/** Must be called synchronously from a user gesture. */
export async function enterFullscreen(): Promise<void> {
  if (!fullscreenSupported() || isFullscreen()) return;
  const el = document.documentElement as PrefixedElement;
  try {
    // The whole document, not the canvas: the Svelte HUD overlay has to come
    // along or the player loses the UI.
    await (el.requestFullscreen?.({ navigationUI: "hide" }) ?? el.webkitRequestFullscreen?.());
  } catch {
    return; // no activation, or the user declined — nothing to recover
  }
  await lockLandscape();
}

export async function exitFullscreen(): Promise<void> {
  if (!isFullscreen()) return;
  try {
    orientation()?.unlock?.();
  } catch {
    /* never locked */
  }
  const d = doc();
  try {
    await (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
  } catch {
    /* already left, e.g. via Esc */
  }
}

/** Flips both the live state and the saved preference. */
export async function toggleFullscreen(): Promise<void> {
  const want = !isFullscreen();
  setFullscreenPreferred(want);
  await (want ? enterFullscreen() : exitFullscreen());
}

/** Subscribe to entering/leaving fullscreen (incl. the user pressing Esc). */
export function onFullscreenChange(cb: (on: boolean) => void): () => void {
  const handler = () => cb(isFullscreen());
  document.addEventListener("fullscreenchange", handler);
  document.addEventListener("webkitfullscreenchange", handler);
  return () => {
    document.removeEventListener("fullscreenchange", handler);
    document.removeEventListener("webkitfullscreenchange", handler);
  };
}
