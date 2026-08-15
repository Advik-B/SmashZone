/**
 * Service-worker registration and the update handshake.
 *
 * The worker never calls `skipWaiting()` on its own, so a freshly installed
 * build sits in `waiting` until this module says go.  That lets an update land
 * silently while the player is on the menu, and hold until they leave a match
 * instead of yanking them out of one.
 */
import { get } from "svelte/store";
import { type Screen, screen, updateReady } from "../ui/app/stores";

/** How often an open tab re-checks for a redeploy. */
const POLL_MS = 15 * 60 * 1000;

/** Screens where a reload costs nothing: no live socket, no match state. */
const SAFE: Screen[] = ["menu", "replayLib"];
const isSafe = (s: Screen) => SAFE.includes(s);

/** `controllerchange` fires once per swap; the guard stops a reload loop. */
let reloading = false;
/** True once a swap is queued behind the player leaving a match. */
let deferred = false;

export function registerServiceWorker(): void {
  // The dev server serves modules straight from source — a worker caching them
  // would only get in the way. `?nosw` opts individual sessions out (the e2e
  // suite uses it so specs always exercise the network).
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;
  if (new URLSearchParams(location.search).has("nosw")) return;

  // The very first worker claims this page as soon as it activates. That one
  // isn't an update — it holds exactly the assets the page already loaded — so
  // it must not trigger a reload; a first visit can easily still be installing
  // while the player is mid-match. Every later change is a real swap.
  let claimed = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!claimed) {
      claimed = true;
      return;
    }
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  void start();
}

async function start(): Promise<void> {
  let reg: ServiceWorkerRegistration;
  try {
    reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    // Unsupported, blocked by policy, or served over plain http — the game
    // works fine without it.
    return;
  }

  // A build installed during an earlier visit can already be waiting.
  if (reg.waiting && navigator.serviceWorker.controller) armSwap(reg.waiting);

  reg.addEventListener("updatefound", () => {
    const next = reg.installing;
    if (!next) return;
    next.addEventListener("statechange", () => {
      // With no controller this is the very first install: nothing to swap.
      if (next.state === "installed" && navigator.serviceWorker.controller) {
        armSwap(next);
      }
    });
  });

  const check = () => void reg.update().catch(() => {});
  setInterval(check, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
}

/** Apply the waiting build now if it's safe to reload, else as soon as it is. */
function armSwap(worker: ServiceWorker): void {
  const apply = () => worker.postMessage("SKIP_WAITING");

  if (isSafe(get(screen))) {
    apply();
    return;
  }

  // `reg.waiting` and `updatefound` can both point at the same build; only the
  // first deferral needs a toast and a subscription.
  if (deferred) return;
  deferred = true;

  updateReady.set({ apply });
  // Unsafe right now, so subscribe's synchronous first call is a no-op and
  // `stop` is safely initialised by the time any later screen change fires.
  const stop = screen.subscribe((s) => {
    if (!isSafe(s)) return;
    updateReady.set(null);
    apply();
    queueMicrotask(() => stop());
  });
}
