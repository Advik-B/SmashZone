// Minimal RIFF/WAVE writer: interleaved 16-bit PCM, for handing an
// OfflineAudioContext render to ffmpeg as `-i audio.wav`.

export function audioBufferToWav(buf: AudioBuffer): Uint8Array {
  const ch = buf.numberOfChannels;
  const frames = buf.length;
  const sr = buf.sampleRate;
  const blockAlign = ch * 2; // 16-bit
  const dataSize = frames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const v = new DataView(out);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // PCM fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, ch, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataSize, true);
  const chans: Float32Array[] = [];
  for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const x = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(out);
}
