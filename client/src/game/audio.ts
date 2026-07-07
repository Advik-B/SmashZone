// Procedurally synthesized SFX — no audio assets, no licensing.
// One shared AudioContext, resumed on the first user gesture.

let ctx: AudioContext | null = null;

function ac(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    const resume = () => {
      ctx?.resume();
    };
    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
  }
  return ctx;
}

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
  osc.connect(g).connect(a.destination);
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
  src.connect(f).connect(g).connect(a.destination);
  src.start(t);
  src.stop(t + dur + 0.05);
}

export const sfx = {
  swing: () => tone(700, 200, 0.09, "sawtooth", 0.05),
  hitLight: () => {
    thump(0.12, 0.4, 1800);
    tone(300, 90, 0.12, "square", 0.12);
  },
  hitHeavy: () => {
    thump(0.22, 0.55, 1200);
    tone(200, 50, 0.25, "square", 0.18);
  },
  jump: () => tone(250, 520, 0.14, "triangle", 0.1),
  dash: () => tone(900, 1400, 0.12, "sawtooth", 0.06),
  slam: () => {
    thump(0.35, 0.6, 500);
    tone(140, 40, 0.35, "sine", 0.25);
  },
  death: () => tone(600, 60, 0.6, "sawtooth", 0.15),
  tileFall: () => thump(0.3, 0.18, 700),
  count: () => tone(440, 440, 0.1, "square", 0.1),
  go: () => {
    tone(660, 660, 0.18, "square", 0.12);
    tone(880, 880, 0.28, "square", 0.1);
  },
  win: () => {
    const seq = [523, 659, 784, 1047];
    seq.forEach((f, i) =>
      setTimeout(() => tone(f, f, 0.22, "triangle", 0.14), i * 130),
    );
  },
  pickupSpawn: () => tone(880, 1320, 0.25, "sine", 0.09),
  pickup: () => {
    tone(523, 1047, 0.16, "triangle", 0.14);
    setTimeout(() => tone(1047, 1568, 0.2, "triangle", 0.1), 90);
  },
  shoot: () => {
    tone(1200, 280, 0.09, "sawtooth", 0.12);
    thump(0.05, 0.18, 3200);
  },
  throwBomb: () => tone(280, 520, 0.16, "sine", 0.11),
  explosion: () => {
    thump(0.5, 0.7, 420);
    tone(130, 32, 0.5, "sawtooth", 0.2);
  },
};
