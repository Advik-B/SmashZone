// Audio: CC0 sampled SFX + music (see CREDITS.md), with a procedural WebAudio
// fallback so the game still sounds right if a sample fails to load. One shared
// AudioContext, resumed on the first user gesture. Everything routes through a
// master gain (volume/mute); music has its own sub-gain (independent slider).

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

/** Play a loaded one-shot sample. Returns false if it isn't available. */
function play(name: string, gain = 1): boolean {
  const buf = buffers.get(name);
  const a = ctx;
  if (!buf || !a || a.state !== "running") return false;
  const src = a.createBufferSource();
  src.buffer = buf;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(g).connect(master());
  src.start(a.currentTime);
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

let noiseBuf: AudioBuffer | null = null;
function noise(): AudioBuffer {
  const a = ac();
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

function env(gainNode: GainNode, t0: number, peak: number, decay: number) {
  const g = gainNode.gain;
  g.setValueAtTime(0.0001, t0);
  g.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.exponentialRampToValueAtTime(0.0001, t0 + decay);
}

function tone(
  freq0: number,
  freq1: number,
  dur: number,
  type: OscillatorType = "square",
  vol = 0.15,
) {
  const a = ac();
  if (a.state !== "running") return;
  const t = a.currentTime;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq1), t + dur);
  env(g, t, vol, dur);
  osc.connect(g).connect(master());
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function thump(dur: number, vol: number, filterHz: number) {
  const a = ac();
  if (a.state !== "running") return;
  const t = a.currentTime;
  const src = a.createBufferSource();
  src.buffer = noise();
  const f = a.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = filterHz;
  const g = a.createGain();
  env(g, t, vol, dur);
  src.connect(f).connect(g).connect(master());
  src.start(t);
  src.stop(t + dur + 0.05);
}

// ---- SFX API (sampled where available, else procedural) -------------------

export const sfx = {
  // Swings stay procedural (no clean CC0 whoosh); pitched per attack type.
  swing: () => tone(700, 200, 0.09, "sawtooth", 0.05),
  swingHeavy: () => tone(460, 130, 0.14, "sawtooth", 0.06),
  swingAir: () => tone(900, 320, 0.11, "sawtooth", 0.05),
  hitLight: () => {
    if (play("hit_light")) return;
    thump(0.12, 0.4, 1800);
    tone(300, 90, 0.12, "square", 0.12);
  },
  hitHeavy: () => {
    if (play("hit_heavy")) return;
    thump(0.22, 0.55, 1200);
    tone(200, 50, 0.25, "square", 0.18);
  },
  jump: () => {
    if (play("jump", 0.6)) return;
    tone(250, 520, 0.14, "triangle", 0.1);
  },
  dash: () => {
    if (play("dash", 0.6)) return;
    tone(900, 1400, 0.12, "sawtooth", 0.06);
  },
  slam: () => {
    if (play("slam")) return;
    thump(0.35, 0.6, 500);
    tone(140, 40, 0.35, "sine", 0.25);
  },
  death: () => {
    if (play("death")) return;
    tone(600, 60, 0.6, "sawtooth", 0.15);
  },
  tileFall: () => thump(0.3, 0.18, 700),
  count: () => tone(440, 440, 0.1, "square", 0.1),
  go: () => {
    tone(660, 660, 0.18, "square", 0.12);
    tone(880, 880, 0.28, "square", 0.1);
  },
  win: () => {
    if (play("win")) return;
    const seq = [523, 659, 784, 1047];
    seq.forEach((f, i) =>
      setTimeout(() => tone(f, f, 0.22, "triangle", 0.14), i * 130),
    );
  },
  pickupSpawn: () => {
    if (play("pickup_spawn", 0.7)) return;
    tone(880, 1320, 0.25, "sine", 0.09);
  },
  pickup: () => {
    if (play("pickup")) return;
    tone(523, 1047, 0.16, "triangle", 0.14);
    setTimeout(() => tone(1047, 1568, 0.2, "triangle", 0.1), 90);
  },
  shoot: () => {
    if (play("shoot", 0.6)) return;
    tone(1200, 280, 0.09, "sawtooth", 0.12);
    thump(0.05, 0.18, 3200);
  },
  throwBomb: () => {
    if (play("throw_bomb", 0.7)) return;
    tone(280, 520, 0.16, "sine", 0.11);
  },
  explosion: () => {
    if (play("explosion")) return;
    thump(0.5, 0.7, 420);
    tone(130, 32, 0.5, "sawtooth", 0.2);
  },
};
