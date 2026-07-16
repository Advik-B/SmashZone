// Lazy lifecycle for one shared ffmpeg-wasm instance. Single-threaded core —
// no SharedArrayBuffer, so no COOP/COEP headers needed anywhere. The runtime
// library loads on demand via dynamic import (same pattern the old mp4-muxer
// used) and the ~32 MB core is fetched lazily from our own hashed assets, so
// the first export pays one cached download and later exports reuse the warm
// instance. Logs go to a ring buffer (never the console) so export failures
// can surface an actionable tail without tripping page-error checks.

import type { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import classWorkerURL from "@ffmpeg/ffmpeg/worker?worker&url";

let inst: Promise<FFmpeg> | null = null;

const LOG_CAP = 64;
const logRing: string[] = [];

function pushLog(message: string) {
  logRing.push(message);
  if (logRing.length > LOG_CAP) logRing.splice(0, logRing.length - LOG_CAP);
}

/** Last n ffmpeg log lines (newest last), for error messages. */
export function ffmpegLogTail(n = 8): string {
  return logRing.slice(-n).join("\n");
}

/** Load (or reuse) the shared instance. A failed load clears the cache so the
 *  next attempt retries from scratch. */
export function loadFFmpeg(): Promise<FFmpeg> {
  inst ??= (async () => {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const ff = new FFmpeg();
    ff.on("log", ({ message }) => pushLog(message));
    await ff.load({ coreURL, wasmURL, classWorkerURL });
    return ff;
  })().catch((e) => {
    inst = null;
    throw e;
  });
  return inst;
}

/** Fire-and-forget warm-up (call when the export dialog opens). */
export function prefetchFFmpeg(): void {
  loadFFmpeg().catch(() => {});
}

/**
 * Kill the worker (export cancel mid-mux). In-flight exec() promises reject
 * with ERROR_TERMINATED; the next loadFFmpeg() starts fresh.
 */
export function terminateFFmpeg(): void {
  const p = inst;
  inst = null;
  p?.then((ff) => ff.terminate()).catch(() => {});
}
