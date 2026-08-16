/**
 * "Add to home screen" plumbing.
 *
 * Installing is what turns the manifest's `display: "fullscreen"` into a real
 * fullscreen launch — no browser chrome at all, and on iPhone it's the *only*
 * way there, since Safari has no Fullscreen API. Chromium lets a page offer the
 * install itself, so the menu does, instead of hoping players find the browser's
 * own tucked-away menu item.
 */
import { writable } from "svelte/store";

/** Not in lib.dom — Chromium-only, and still non-standard. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let pending: BeforeInstallPromptEvent | null = null;

/** True only while an install can actually be offered right now. */
export const canInstall = writable(false);

/** Already launched as an installed app (so there's nothing to offer). */
export function isInstalled(): boolean {
  return (
    matchMedia("(display-mode: standalone)").matches ||
    matchMedia("(display-mode: fullscreen)").matches
  );
}

export function watchInstallPrompt(): void {
  if (isInstalled()) return;

  window.addEventListener("beforeinstallprompt", (e) => {
    // Suppress Chrome's own mini-infobar so the menu button is the one offer.
    e.preventDefault();
    pending = e as BeforeInstallPromptEvent;
    canInstall.set(true);
  });

  window.addEventListener("appinstalled", () => {
    pending = null;
    canInstall.set(false);
  });
}

/** Show the browser's install dialog. The event is single-use. */
export async function promptInstall(): Promise<void> {
  const event = pending;
  if (!event) return;
  pending = null;
  canInstall.set(false);
  try {
    await event.prompt();
    // A dismissal doesn't come back: Chrome re-fires beforeinstallprompt on a
    // later visit if the player is still eligible, which re-arms the button.
    await event.userChoice;
  } catch {
    /* dialog refused to open — nothing useful to say about it */
  }
}
