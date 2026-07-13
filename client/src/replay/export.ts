// Video export. Two pipelines:
//
// - "mp4": offline, frame-perfect. Steps the replay at exact 1/fps intervals
//   in tick-space (never wall clock), captures each render as a VideoFrame,
//   encodes with WebCodecs (H.264 probe, VP9 fallback) and muxes via
//   mp4-muxer. The loop yields through a MessageChannel so it keeps encoding
//   at full speed when the tab is backgrounded, and typically finishes
//   faster than real time. Silent (SFX are a live WebAudio graph).
//
// - "webm": realtime capture through canvas.captureStream + MediaRecorder,
//   with the game's master audio bus mixed in. Runs at 1x wall clock and
//   needs the tab visible, but it's the path with sound — and the automatic
//   fallback for browsers without WebCodecs.
//
// Either way the canvas is retargeted to the exact encode resolution for the
// duration (renderer.setRenderSize/restoreSize) and the player's transport
// state is restored afterwards.

import constants from "../../../shared/constants.json";
import { captureAudioStream } from "../game/audio";
import type { ReplayPlayer } from "./player";

const TICK_MS = 1000 / constants.tickRate;

export interface ExportRequest {
  width: number;
  height: number;
  fps: 30 | 60;
  camera: "follow" | "playerview";
  targetId: number;
  startTick: number;
  endTick: number;
  mode: "mp4" | "webm";
  onProgress?: (frac: number) => void;
}

export interface ExportHandle {
  done: Promise<Blob>;
  cancel(): void;
}

export class ExportCancelled extends Error {
  constructor() {
    super("export cancelled");
  }
}

export function webCodecsAvailable(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

function bitrateFor(width: number, fps: number): number {
  const base = width >= 1920 ? 10_000_000 : 6_000_000;
  return fps >= 60 ? Math.round(base * 1.55) : base;
}

/** H.264 first (plays everywhere), VP9-in-MP4 second (Chromium/VLC-safe). */
async function pickCodec(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<{ codec: string; mux: "avc" | "vp9" } | null> {
  if (!webCodecsAvailable()) return null;
  const candidates: { codec: string; mux: "avc" | "vp9" }[] = [
    { codec: "avc1.640033", mux: "avc" }, // High L5.1 (covers 1080p60)
    { codec: "avc1.64002a", mux: "avc" },
    { codec: "avc1.42003e", mux: "avc" },
    { codec: "vp09.00.41.08", mux: "vp9" },
    { codec: "vp09.00.10.08", mux: "vp9" },
  ];
  for (const c of candidates) {
    try {
      const s = await VideoEncoder.isConfigSupported({
        codec: c.codec,
        width,
        height,
        bitrate,
        framerate: fps,
      });
      if (s.supported) return c;
    } catch {
      /* malformed-config throw = not supported */
    }
  }
  return null;
}

/** Macrotask yield that keeps ticking in backgrounded tabs (unlike rAF). */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

export function exportVideo(player: ReplayPlayer, req: ExportRequest): ExportHandle {
  let cancelled = false;
  let stopRealtime: (() => void) | null = null;

  const done = (async () => {
    const resumePlayhead = player.playheadTick;
    player.renderer.setRenderSize(req.width, req.height);
    player.beginExport(req.startTick, req.targetId, req.mode === "webm");
    try {
      if (req.mode === "mp4") {
        return await exportMp4(player, req, () => cancelled);
      }
      return await exportWebm(player, req, () => cancelled, (stop) => {
        stopRealtime = stop;
      });
    } finally {
      player.endExport();
      player.renderer.restoreSize();
      player.seek(resumePlayhead);
    }
  })();

  return {
    done,
    cancel() {
      cancelled = true;
      stopRealtime?.();
    },
  };
}

async function exportMp4(
  player: ReplayPlayer,
  req: ExportRequest,
  isCancelled: () => boolean,
): Promise<Blob> {
  const bitrate = bitrateFor(req.width, req.fps);
  const picked = await pickCodec(req.width, req.height, req.fps, bitrate);
  if (!picked) throw new Error("this browser can't encode MP4 — use the WebM export");
  const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: picked.mux, width: req.width, height: req.height },
    fastStart: "in-memory",
  });
  let encError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encError = e;
    },
  });
  encoder.configure({
    codec: picked.codec,
    width: req.width,
    height: req.height,
    bitrate,
    framerate: req.fps,
    latencyMode: "quality",
  });

  const ticksPerFrame = constants.tickRate / req.fps;
  const totalFrames = Math.max(
    1,
    Math.floor((req.endTick - req.startTick) / ticksPerFrame),
  );
  const usPerFrame = 1e6 / req.fps;

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (isCancelled()) throw new ExportCancelled();
      if (encError) throw encError;
      player.exportStep(req.startTick + i * ticksPerFrame, 1 / req.fps, req.camera);
      const frame = new VideoFrame(player.renderer.canvas, {
        timestamp: Math.round(i * usPerFrame),
        duration: Math.round(usPerFrame),
      });
      encoder.encode(frame, { keyFrame: i % (req.fps * 2) === 0 });
      frame.close();
      // Backpressure: don't let raw frames pile up ahead of the encoder.
      while (encoder.encodeQueueSize > 4 && !encError) await nextTask();
      if (i % 8 === 0) {
        req.onProgress?.(i / totalFrames);
        await nextTask();
      }
    }
    if (encError) throw encError;
    await encoder.flush();
    muxer.finalize();
    req.onProgress?.(1);
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally {
    try {
      encoder.close();
    } catch {
      /* already closed by flush error */
    }
  }
}

async function exportWebm(
  player: ReplayPlayer,
  req: ExportRequest,
  isCancelled: () => boolean,
  registerStop: (stop: () => void) => void,
): Promise<Blob> {
  const canvas = player.renderer.canvas;
  const stream = canvas.captureStream(0); // frames pushed manually
  const videoTrack = stream.getVideoTracks()[0] as MediaStreamTrack & {
    requestFrame?: () => void;
  };
  const audio = captureAudioStream();
  if (audio) for (const t of audio.stream.getAudioTracks()) stream.addTrack(t);

  const mime =
    ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) =>
      MediaRecorder.isTypeSupported(m),
    ) ?? "";
  const rec = new MediaRecorder(stream, {
    ...(mime ? { mimeType: mime } : {}),
    videoBitsPerSecond: bitrateFor(req.width, req.fps),
  });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
  });
  rec.start(250);

  // Real-time pacing: advance the playhead by wall-clock time at 1x and push
  // a captured frame per rAF. (rAF throttles when hidden — the dialog warns.)
  const span = req.endTick - req.startTick;
  let raf = 0;
  let finished: () => void = () => {};
  const finishedP = new Promise<void>((resolve) => {
    finished = resolve;
  });
  registerStop(() => {
    cancelAnimationFrame(raf);
    finished();
  });
  const t0 = performance.now();
  let lastNow = t0;
  const pump = (now: number) => {
    const tick = req.startTick + (now - t0) / TICK_MS;
    const dtSec = Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;
    player.exportStep(tick, dtSec, req.camera);
    videoTrack.requestFrame?.();
    req.onProgress?.(Math.min(1, (tick - req.startTick) / span));
    if (tick >= req.endTick || isCancelled()) {
      finished();
      return;
    }
    raf = requestAnimationFrame(pump);
  };
  raf = requestAnimationFrame(pump);
  await finishedP;

  rec.stop();
  await stopped;
  audio?.stop();
  for (const t of stream.getTracks()) t.stop();
  if (isCancelled()) throw new ExportCancelled();
  req.onProgress?.(1);
  return new Blob(chunks, { type: mime.split(";")[0] || "video/webm" });
}
