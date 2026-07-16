// Audio: CC0 sampled SFX + music (see CREDITS.md), with a procedural WebAudio
// fallback so the game still sounds right if a sample fails to load. One shared
// AudioContext, resumed on the first user gesture. Everything routes through a
// master gain (volume/mute); music has its own sub-gain (independent slider).
//
// Every one-shot is a *recipe*: a function scheduling nodes onto an AudioSink
// { ctx, bus, t }. Live play points the sink at the shared context's master
// bus at currentTime. The video exporter instead captures a tape of
// (name, arg, t) entries and replays the same recipes into an
// OfflineAudioContext (renderExportAudio) — deterministic export sound.

import { pitchVar } from "./juice";

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

let volume = clampVol(parseFloat(localStorage.getItem("sz-volume") ?? "0.8"));
let muted = localStorage.getItem("sz-muted") === "1";
let musicVol = clampVol(parseFloat(localStorage.getItem("sz-music-vol") ?? "0.5"));
let musicMuted = localStorage.getItem("sz-music-muted") === "1";

function clampVol(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8;
}

function ac(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    // Resume on the first gesture and (re)sync music; once the context is
    // actually running, drop the listeners so they don't fire on every input.
    const resume = () => {
      ctx
        ?.resume()
        .then(() => {
          syncMusic();
          if (ctx?.state === "running") {
            window.removeEventListener("pointerdown", resume);
            window.removeEventListener("keydown", resume);
          }
        })
        .catch(() => {});
    };
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
  }
  return ctx;
}

/** Master bus: every sound routes through this so volume/mute apply globally. */
function master(): GainNode {
  const a = ac();
  if (!masterGain) {
    masterGain = a.createGain();
    masterGain.gain.value = muted ? 0 : volume;
    masterGain.connect(a.destination);
  }
  return masterGain;
}

function applyGain() {
  if (masterGain && ctx) {
    masterGain.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.02);
  }
}

/**
 * Tap the master bus into a MediaStream (real-time video export with game
 * audio). Honors the current volume/mute. Call stop() to detach the tap.
 */
export function captureAudioStream(): { stream: MediaStream; stop(): void } | null {
  if (!ctx) return null; // no AudioContext yet (no user gesture)
  const dest = ctx.createMediaStreamDestination();
  const bus = master();
  bus.connect(dest);
  return {
    stream: dest.stream,
    stop() {
      try {
        bus.disconnect(dest);
      } catch {
        /* already detached */
      }
    },
  };
}

export function setVolume(v: number) {
  volume = clampVol(v);
  localStorage.setItem("sz-volume", String(volume));
  applyGain();
}
export function getVolume(): number {
  return volume;
}
export function setMuted(m: boolean) {
  muted = m;
  localStorage.setItem("sz-muted", m ? "1" : "0");
  applyGain();
}
export function isMuted(): boolean {
  return muted;
}

// ---- Sampled assets -------------------------------------------------------

const ASSET_BASE = "/assets/audio/";
const SFX_FILES = [
  "hit_light",
  "hit_heavy",
  "slam",
  "jump",
  "dash",
  "pickup",
  "pickup_spawn",
  "shoot",
  "throw_bomb",
  "explosion",
  "death",
  "win",
] as const;
const MUSIC_FILES = ["music_menu", "music_battle"] as const;

const buffers = new Map<string, AudioBuffer>();

async function loadOne(name: string) {
  try {
    const res = await fetch(`${ASSET_BASE}${name}.ogg`);
    if (!res.ok) return;
    const data = await res.arrayBuffer();
    const buf = await ac().decodeAudioData(data);
    buffers.set(name, buf);
  } catch {
    // Missing/undecodable → the caller falls back to procedural synthesis.
  }
}

/** Preload all SFX + music buffers (call once at startup). Never rejects. */
export async function loadAudio(): Promise<void> {
  await Promise.allSettled([...SFX_FILES, ...MUSIC_FILES].map(loadOne));
}

// ---- Recipe plumbing ------------------------------------------------------

/** Where and when a recipe schedules its nodes (live bus or offline render). */
interface AudioSink {
  ctx: BaseAudioContext;
  bus: AudioNode;
  t: number;
}

/** Schedule a loaded one-shot sample. Returns false if it isn't available. */
function playAt(s: AudioSink, name: string, gain = 1, rate = 1): boolean {
  const buf = buffers.get(name);
  if (!buf) return false;
  const src = s.ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const g = s.ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(s.bus);
  src.start(s.t);
  return true;
}

// ---- Music ----------------------------------------------------------------

let musicGain: GainNode | null = null;
let musicSource: AudioBufferSourceNode | null = null;
let currentTrack: string | null = null;
let desiredTrack: string | null = null;

function musicBus(): GainNode {
  const a = ac();
  if (!musicGain) {
    musicGain = a.createGain();
    musicGain.gain.value = musicMuted ? 0 : musicVol;
    musicGain.connect(master());
  }
  return musicGain;
}

function applyMusicGain() {
  if (musicGain && ctx) {
    musicGain.gain.setTargetAtTime(musicMuted ? 0 : musicVol, ctx.currentTime, 0.05);
  }
}

/** Start/stop the looping music source to match `desiredTrack`. */
function syncMusic() {
  const a = ctx;
  if (!a || a.state !== "running") return; // retried after resume
  if (currentTrack === desiredTrack) return;
  if (musicSource) {
    try {
      musicSource.stop();
    } catch {
      /* already stopped */
    }
    musicSource = null;
  }
  currentTrack = desiredTrack;
  if (!desiredTrack) return;
  const buf = buffers.get(desiredTrack);
  if (!buf) return;
  const src = a.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(musicBus());
  src.start(a.currentTime);
  musicSource = src;
}

/** Request a background track ("menu" | "battle" | null to stop). */
export function playMusic(track: "menu" | "battle" | null) {
  desiredTrack = track === null ? null : `music_${track}`;
  ac(); // ensure context + resume hooks exist
  syncMusic();
}

export function setMusicVolume(v: number) {
  musicVol = clampVol(v);
  localStorage.setItem("sz-music-vol", String(musicVol));
  applyMusicGain();
}
export function getMusicVolume(): number {
  return musicVol;
}
export function setMusicMuted(m: boolean) {
  musicMuted = m;
  localStorage.setItem("sz-music-muted", m ? "1" : "0");
  applyMusicGain();
}
export function isMusicMuted(): boolean {
  return musicMuted;
}

// ---- Procedural fallback synthesis ----------------------------------------

/** 1 s of white noise per context (offline renders get their own, GC-able). */
const noiseBufs = new WeakMap<BaseAudioContext, AudioBuffer>();
function noiseFor(c: BaseAudioContext): AudioBuffer {
  let buf = noiseBufs.get(c);
  if (!buf) {
    buf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBufs.set(c, buf);
  }
  return buf;
}

function env(gainNode: GainNode, t0: number, peak: number, decay: number) {
  const g = gainNode.gain;
  g.setValueAtTime(0.0001, t0);
  g.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.exponentialRampToValueAtTime(0.0001, t0 + decay);
}

function toneAt(
  s: AudioSink,
  freq0: number,
  freq1: number,
  dur: number,
  type: OscillatorType = "square",
  vol = 0.15,
) {
  const osc = s.ctx.createOscillator();
  const g = s.ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq0, s.t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq1), s.t + dur);
  env(g, s.t, vol, dur);
  osc.connect(g).connect(s.bus);
  osc.start(s.t);
  osc.stop(s.t + dur + 0.05);
}

function thumpAt(s: AudioSink, dur: number, vol: number, filterHz: number) {
  const src = s.ctx.createBufferSource();
  src.buffer = noiseFor(s.ctx);
  const f = s.ctx.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = filterHz;
  const g = s.ctx.createGain();
  env(g, s.t, vol, dur);
  src.connect(f).connect(g).connect(s.bus);
  src.start(s.t);
  src.stop(s.t + dur + 0.05);
}

// ---- SFX recipes (sampled where available, else procedural) ----------------
// Repeated one-shots get a small random pitch variance (and hits accept a
// combo pitch multiplier) so back-to-back plays don't machine-gun.

const RECIPES = {
  // Swings stay procedural (no clean CC0 whoosh); pitched per attack type.
  swing: (s: AudioSink) => {
    const r = pitchVar();
    toneAt(s, 700 * r, 200 * r, 0.09, "sawtooth", 0.05);
  },
  swingHeavy: (s: AudioSink) => {
    const r = pitchVar();
    toneAt(s, 460 * r, 130 * r, 0.14, "sawtooth", 0.06);
  },
  swingAir: (s: AudioSink) => {
    const r = pitchVar();
    toneAt(s, 900 * r, 320 * r, 0.11, "sawtooth", 0.05);
  },
  hitLight: (s: AudioSink, pitch = 1) => {
    const r = pitch * pitchVar();
    if (playAt(s, "hit_light", 1, r)) return;
    thumpAt(s, 0.12, 0.4, 1800 * r);
    toneAt(s, 300 * r, 90 * r, 0.12, "square", 0.12);
  },
  hitHeavy: (s: AudioSink, pitch = 1) => {
    const r = pitch * pitchVar();
    if (playAt(s, "hit_heavy", 1, r)) {
      thumpAt(s, 0.18, 0.25, 320); // sub-bass crunch the sample lacks
      return;
    }
    thumpAt(s, 0.22, 0.55, 1200);
    toneAt(s, 200 * r, 50 * r, 0.25, "square", 0.18);
  },
  jump: (s: AudioSink) => {
    const r = pitchVar();
    if (playAt(s, "jump", 0.6, r)) return;
    toneAt(s, 250 * r, 520 * r, 0.14, "triangle", 0.1);
  },
  dash: (s: AudioSink) => {
    const r = pitchVar();
    if (playAt(s, "dash", 0.6, r)) return;
    toneAt(s, 900 * r, 1400 * r, 0.12, "sawtooth", 0.06);
  },
  slam: (s: AudioSink) => {
    const r = pitchVar(0.04);
    if (playAt(s, "slam", 1, r)) return;
    thumpAt(s, 0.35, 0.6, 500);
    toneAt(s, 140, 40, 0.35, "sine", 0.25);
  },
  death: (s: AudioSink) => {
    const r = pitchVar(0.04);
    if (playAt(s, "death", 1, r)) {
      // Layer weight under the sample: sub-bass hit + falling whine.
      thumpAt(s, 0.4, 0.35, 300);
      toneAt(s, 220, 40, 0.5, "sine", 0.1);
      return;
    }
    toneAt(s, 600 * r, 60, 0.6, "sawtooth", 0.15);
  },
  tileFall: (s: AudioSink) => thumpAt(s, 0.3, 0.18, 700),
  count: (s: AudioSink) => toneAt(s, 440, 440, 0.1, "square", 0.1),
  go: (s: AudioSink) => {
    toneAt(s, 660, 660, 0.18, "square", 0.12);
    toneAt(s, 880, 880, 0.28, "square", 0.1);
  },
  win: (s: AudioSink) => {
    if (playAt(s, "win")) return;
    // Fanfare scheduled on the audio clock, not setTimeout (offline-safe).
    [523, 659, 784, 1047].forEach((f, i) =>
      toneAt({ ...s, t: s.t + i * 0.13 }, f, f, 0.22, "triangle", 0.14),
    );
  },
  pickupSpawn: (s: AudioSink) => {
    if (playAt(s, "pickup_spawn", 0.7)) return;
    toneAt(s, 880, 1320, 0.25, "sine", 0.09);
  },
  pickup: (s: AudioSink) => {
    const r = pitchVar(0.04);
    if (playAt(s, "pickup", 1, r)) return;
    toneAt(s, 523, 1047, 0.16, "triangle", 0.14);
    toneAt({ ...s, t: s.t + 0.09 }, 1047, 1568, 0.2, "triangle", 0.1);
  },
  shoot: (s: AudioSink) => {
    const r = pitchVar();
    if (playAt(s, "shoot", 0.6, r)) return;
    toneAt(s, 1200 * r, 280 * r, 0.09, "sawtooth", 0.12);
    thumpAt(s, 0.05, 0.18, 3200);
  },
  throwBomb: (s: AudioSink) => {
    if (playAt(s, "throw_bomb", 0.7)) return;
    toneAt(s, 280, 520, 0.16, "sine", 0.11);
  },
  explosion: (s: AudioSink) => {
    if (playAt(s, "explosion")) return;
    thumpAt(s, 0.5, 0.7, 420);
    toneAt(s, 130, 32, 0.5, "sawtooth", 0.2);
  },
} satisfies Record<string, (s: AudioSink, arg?: number) => void>;

type SfxName = keyof typeof RECIPES;

function runRecipe(name: SfxName, s: AudioSink, arg?: number): void {
  (RECIPES[name] as (s: AudioSink, arg?: number) => void)(s, arg);
}

// ---- Export tape ------------------------------------------------------------
// While capturing, sfx calls record (name, arg, t) instead of sounding; the
// exporter replays the tape into an OfflineAudioContext afterwards.

export interface SfxTapeEntry {
  name: SfxName;
  arg: number | undefined;
  t: number;
}

let tape: SfxTapeEntry[] | null = null;
let tapeT = 0;

export function startSfxCapture(): void {
  tape = [];
  tapeT = 0;
}

/** Timeline position (seconds) stamped onto subsequently captured calls. */
export function setSfxCaptureTime(tSec: number): void {
  tapeT = tSec;
}

/** Stop capturing and return the tape; null if capture wasn't active. */
export function stopSfxCapture(): SfxTapeEntry[] | null {
  const t = tape;
  tape = null;
  return t;
}

// ---- Live dispatch ----------------------------------------------------------

function liveSink(): AudioSink | null {
  const a = ac(); // ensures the context + resume listeners exist
  if (a.state !== "running") return null; // pre-gesture: stay silent
  return { ctx: a, bus: master(), t: a.currentTime };
}

function emit(name: SfxName, arg?: number): void {
  if (tape) {
    tape.push({ name, arg, t: tapeT });
    return;
  }
  const s = liveSink();
  if (s) runRecipe(name, s, arg);
}

export const sfx = {
  swing: () => emit("swing"),
  swingHeavy: () => emit("swingHeavy"),
  swingAir: () => emit("swingAir"),
  hitLight: (pitch = 1) => emit("hitLight", pitch),
  hitHeavy: (pitch = 1) => emit("hitHeavy", pitch),
  jump: () => emit("jump"),
  dash: () => emit("dash"),
  slam: () => emit("slam"),
  death: () => emit("death"),
  tileFall: () => emit("tileFall"),
  count: () => emit("count"),
  go: () => emit("go"),
  win: () => emit("win"),
  pickupSpawn: () => emit("pickupSpawn"),
  pickup: () => emit("pickup"),
  shoot: () => emit("shoot"),
  throwBomb: () => emit("throwBomb"),
  explosion: () => emit("explosion"),
};

// ---- Offline export render --------------------------------------------------

/** Reference mix for exports: the game's default volumes, deliberately NOT the
 *  user's live sliders — a muted player should still get an audible video. */
const EXPORT_MASTER_LEVEL = 0.8;
const EXPORT_MUSIC_LEVEL = 0.5;

/**
 * Render a captured SFX tape (plus the battle-music bed) into a stereo 48 kHz
 * buffer of exactly durationSec. Sample buffers decoded on the live context
 * are context-independent, so this works even while the live context is
 * suspended (e.g. headless browsers with no user gesture).
 */
export async function renderExportAudio(
  tape: SfxTapeEntry[],
  durationSec: number,
  withMusic = true,
): Promise<AudioBuffer> {
  const sr = 48000;
  const off = new OfflineAudioContext(2, Math.max(1, Math.ceil(durationSec * sr)), sr);
  const bus = off.createGain();
  bus.gain.value = EXPORT_MASTER_LEVEL;
  bus.connect(off.destination);
  if (withMusic) {
    const music = buffers.get("music_battle");
    if (music) {
      const src = off.createBufferSource();
      src.buffer = music;
      src.loop = true;
      const mg = off.createGain();
      mg.gain.value = EXPORT_MUSIC_LEVEL;
      src.connect(mg).connect(bus);
      src.start(0);
    }
  }
  for (const e of tape) {
    if (e.t <= durationSec) runRecipe(e.name, { ctx: off, bus, t: e.t }, e.arg);
  }
  return off.startRendering();
}
