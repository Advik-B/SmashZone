// Offline video export: one pipeline, frame-perfect, with sound.
//
// The replay is stepped at exact 1/fps intervals in tick-space (never wall
// clock); each render is captured as a VideoFrame and encoded with WebCodecs
// (hardware H.264 where available, VP9 fallback) into a raw elementary
// stream. Sounds fired along the way land on a tape (game/audio.ts) and are
// re-rendered through an OfflineAudioContext at the same frame times. ffmpeg
// (wasm, single-threaded core) then muxes the stream at a declared framerate
// together with the AAC soundtrack into a true constant-frame-rate MP4 —
// container timing is independent of encode pacing, which is what keeps
// playback smooth in normal video players. The loop yields through a
// MessageChannel so it keeps encoding at full speed in a backgrounded tab,
// and typically finishes faster than real time.
//
// The canvas is retargeted to the exact encode resolution for the duration
// (renderer.setRenderSize/restoreSize) and the player's transport state is
// restored afterwards.

import constants from "../../../shared/constants.json";
import {
  renderExportAudio,
  setSfxCaptureTime,
  startSfxCapture,
  stopSfxCapture,
} from "../game/audio";
import {
  avccToAnnexB,
  concatBytes,
  ivfFrameHeader,
  ivfHeader,
  parseAvcC,
  type AvcCInfo,
} from "./bitstream";
import { ffmpegLogTail, loadFFmpeg, terminateFFmpeg } from "./ffmpeg";
import { audioBufferToWav } from "./wav";
import type { ReplayPlayer } from "./player";

export type ExportPhase = "render" | "audio" | "mux";

export interface ExportRequest {
  width: number;
  height: number;
  fps: 30 | 60;
  camera: "follow" | "playerview";
  targetId: number;
  startTick: number;
  endTick: number;
  quality: "standard" | "high";
  sound: boolean;
  onProgress?: (frac: number) => void;
  onPhase?: (phase: ExportPhase) => void;
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

function bitrateFor(width: number, fps: number, quality: "standard" | "high"): number {
  const base = width >= 1920 ? 10_000_000 : 6_000_000;
  const scaled = fps >= 60 ? base * 1.55 : base;
  return Math.round(quality === "high" ? scaled * 1.6 : scaled);
}

/**
 * H.264 first (plays everywhere), VP9-in-MP4 second (Chromium/VLC-safe).
 * Prefer encoders that emit Annex-B directly; fall back to AVCC output with
 * manual conversion (bitstream.ts) where the config is rejected.
 */
type PickedCodec = { codec: string; container: "h264" | "ivf"; annexb: boolean };

const H264_CODECS = ["avc1.640033", "avc1.64002a", "avc1.42003e"]; // High L5.1 covers 1080p60
const VP9_CODECS = ["vp09.00.41.08", "vp09.00.10.08"];

async function pickCodec(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<PickedCodec | null> {
  if (!webCodecsAvailable()) return null;
  const probe = async (config: VideoEncoderConfig) => {
    try {
      return (await VideoEncoder.isConfigSupported(config)).supported === true;
    } catch {
      return false; // malformed-config throw = not supported
    }
  };
  const base = { width, height, bitrate, framerate: fps };
  for (const codec of H264_CODECS) {
    if (await probe({ ...base, codec, avc: { format: "annexb" } }))
      return { codec, container: "h264", annexb: true };
  }
  for (const codec of H264_CODECS) {
    if (await probe({ ...base, codec })) return { codec, container: "h264", annexb: false };
  }
  for (const codec of VP9_CODECS) {
    if (await probe({ ...base, codec })) return { codec, container: "ivf", annexb: false };
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

function bufferBytes(b: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return new Uint8Array(b);
}

export function exportVideo(player: ReplayPlayer, req: ExportRequest): ExportHandle {
  let cancelled = false;
  // True only while ffmpeg holds in-flight work for THIS export, so a cancel
  // after success (the dialog's unconditional cancel-on-close) never kills
  // the warm instance.
  const mux = { active: false };

  const done = (async () => {
    const resumePlayhead = player.playheadTick;
    player.renderer.setRenderSize(req.width, req.height);
    // Capture must be on before beginExport: its drawWorld(0) can already
    // fire a countdown beep at t=0.
    if (req.sound) startSfxCapture();
    player.beginExport(req.startTick, req.targetId, req.sound);
    try {
      return await exportMp4(player, req, () => cancelled, mux);
    } finally {
      stopSfxCapture(); // idempotent — tape mode must never outlive the export
      player.endExport();
      player.renderer.restoreSize();
      player.seek(resumePlayhead);
    }
  })();

  return {
    done,
    cancel() {
      cancelled = true;
      if (mux.active) terminateFFmpeg(); // rejects the in-flight exec
    },
  };
}

async function exportMp4(
  player: ReplayPlayer,
  req: ExportRequest,
  isCancelled: () => boolean,
  mux: { active: boolean },
): Promise<Blob> {
  const bitrate = bitrateFor(req.width, req.fps, req.quality);
  const picked = await pickCodec(req.width, req.height, req.fps, bitrate);
  if (!picked) throw new Error("this browser can't encode video (WebCodecs is required)");
  // Overlap the (cached-after-first-use) ffmpeg core fetch with the render;
  // failures surface at mux time via the fresh loadFFmpeg() call.
  loadFFmpeg().catch(() => {});

  const parts: Uint8Array[] = [];
  let avcc: AvcCInfo | null = null;
  let chunkCount = 0;
  let encError: unknown = null;

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      if (picked.container === "ivf") {
        parts.push(ivfFrameHeader(bytes.length, chunkCount), bytes);
      } else if (picked.annexb) {
        parts.push(bytes);
      } else {
        const desc = meta?.decoderConfig?.description;
        if (desc) avcc = parseAvcC(bufferBytes(desc));
        if (!avcc) {
          encError ??= new Error("H.264 encoder provided no AVCC description");
          return;
        }
        if (chunk.type === "key") parts.push(avcc.headers);
        parts.push(avccToAnnexB(bytes, avcc.nalLengthSize));
      }
      chunkCount++;
    },
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
    ...(picked.annexb ? { avc: { format: "annexb" as const } } : {}),
  });

  const ticksPerFrame = constants.tickRate / req.fps;
  const totalFrames = Math.max(
    1,
    Math.floor((req.endTick - req.startTick) / ticksPerFrame),
  );
  const usPerFrame = 1e6 / req.fps;

  req.onPhase?.("render");
  try {
    for (let i = 0; i < totalFrames; i++) {
      if (isCancelled()) throw new ExportCancelled();
      if (encError) throw encError;
      // Tape timestamps ride the frame clock: everything exportStep fires
      // (events, tile falls, countdown) lands at this frame's time.
      if (req.sound) setSfxCaptureTime(i / req.fps);
      player.exportStep(req.startTick + i * ticksPerFrame, 1 / req.fps, req.camera);
      // The frame timestamps feed encoder rate control only — final container
      // timing comes from ffmpeg's declared framerate below.
      const frame = new VideoFrame(player.renderer.canvas, {
        timestamp: Math.round(i * usPerFrame),
        duration: Math.round(usPerFrame),
      });
      encoder.encode(frame, { keyFrame: i % (req.fps * 2) === 0 });
      frame.close();
      // Backpressure: don't let raw frames pile up ahead of the encoder.
      while (encoder.encodeQueueSize > 4 && !encError) await nextTask();
      if (i % 8 === 0) {
        req.onProgress?.(0.82 * (i / totalFrames));
        await nextTask();
      }
    }
    if (encError) throw encError;
    await encoder.flush();
    if (encError) throw encError;
  } finally {
    try {
      encoder.close();
    } catch {
      /* already closed by flush error */
    }
  }

  // Soundtrack: replay the captured tape offline at the same frame times.
  const durationSec = totalFrames / req.fps;
  let wav: Uint8Array | null = null;
  if (req.sound) {
    if (isCancelled()) throw new ExportCancelled();
    req.onPhase?.("audio");
    req.onProgress?.(0.82);
    const tape = stopSfxCapture() ?? [];
    wav = audioBufferToWav(await renderExportAudio(tape, durationSec));
  }

  if (isCancelled()) throw new ExportCancelled();
  req.onPhase?.("mux");
  req.onProgress?.(0.88);
  let ff;
  try {
    ff = await loadFFmpeg();
  } catch (e) {
    throw new Error(
      `couldn't load the mp4 encoder: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const videoName = picked.container === "ivf" ? "video.ivf" : "video.h264";
  const video =
    picked.container === "ivf"
      ? concatBytes([ivfHeader(req.width, req.height, req.fps, chunkCount), ...parts])
      : concatBytes(parts);
  parts.length = 0; // free the duplicates before MEMFS gets its copy

  mux.active = true;
  try {
    try {
      await ff.writeFile(videoName, video);
      if (wav) await ff.writeFile("audio.wav", wav);
      const args = ["-y"];
      // Raw H.264 has no timestamps: -framerate declares exact CFR spacing
      // and +genpts covers reordered (B-frame) streams. IVF carries its own
      // 1/fps timebase.
      if (picked.container === "h264")
        args.push("-fflags", "+genpts", "-framerate", String(req.fps));
      args.push("-i", videoName);
      if (wav) args.push("-i", "audio.wav", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest");
      else args.push("-c:v", "copy", "-an");
      args.push("-movflags", "+faststart", "out.mp4");

      const ret = await ff.exec(args);
      if (ret !== 0)
        throw new Error(`mp4 mux failed (ffmpeg exit ${ret})\n${ffmpegLogTail(4)}`);
      // Drop the inputs before reading the output to cap MEMFS peak size.
      for (const f of [videoName, "audio.wav"]) {
        try {
          await ff.deleteFile(f);
        } catch {
          /* not written */
        }
      }
      const data = await ff.readFile("out.mp4");
      req.onProgress?.(1);
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      return new Blob([bytes as BlobPart], { type: "video/mp4" });
    } catch (e) {
      if (e instanceof ExportCancelled) throw e;
      if (isCancelled()) throw new ExportCancelled(); // terminate() rejected us
      throw e;
    }
  } finally {
    mux.active = false;
    // Best-effort cleanup; a failed exec must not strand files in the cached
    // instance (a terminated one lost its FS anyway).
    for (const f of [videoName, "audio.wav", "out.mp4"]) {
      try {
        await ff.deleteFile(f);
      } catch {
        /* missing or terminated */
      }
    }
  }
}
