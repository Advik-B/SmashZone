// Byte-level helpers for handing WebCodecs output to ffmpeg as elementary
// streams: AVCC→Annex-B conversion for H.264 (when the encoder can't emit
// Annex-B itself) and IVF framing for VP9.

const START_CODE = new Uint8Array([0, 0, 0, 1]);

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export interface AvcCInfo {
  nalLengthSize: number;
  /** SPS/PPS as an Annex-B blob, to re-emit before each keyframe. */
  headers: Uint8Array;
}

/** Parse an AVCDecoderConfigurationRecord (VideoDecoderConfig.description). */
export function parseAvcC(desc: Uint8Array): AvcCInfo {
  const nalLengthSize = (desc[4] & 0x03) + 1;
  const parts: Uint8Array[] = [];
  let off = 5;
  const spsCount = desc[off] & 0x1f;
  off += 1;
  for (let i = 0; i < spsCount; i++) {
    const len = (desc[off] << 8) | desc[off + 1];
    off += 2;
    parts.push(START_CODE, desc.subarray(off, off + len));
    off += len;
  }
  const ppsCount = desc[off];
  off += 1;
  for (let i = 0; i < ppsCount; i++) {
    const len = (desc[off] << 8) | desc[off + 1];
    off += 2;
    parts.push(START_CODE, desc.subarray(off, off + len));
    off += len;
  }
  return { nalLengthSize, headers: concatBytes(parts) };
}

/** Rewrite length-prefixed AVCC NAL units as Annex-B start-code units. */
export function avccToAnnexB(data: Uint8Array, nalLengthSize: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let off = 0;
  while (off + nalLengthSize <= data.length) {
    let len = 0;
    for (let i = 0; i < nalLengthSize; i++) len = (len << 8) | data[off + i];
    off += nalLengthSize;
    if (len <= 0 || off + len > data.length) break; // malformed tail
    parts.push(START_CODE, data.subarray(off, off + len));
    off += len;
  }
  return concatBytes(parts);
}

/** 32-byte IVF file header; timebase 1/fps so pts = frame index → exact CFR. */
export function ivfHeader(
  width: number,
  height: number,
  fps: number,
  frameCount: number,
): Uint8Array {
  const h = new Uint8Array(32);
  const v = new DataView(h.buffer);
  h.set([0x44, 0x4b, 0x49, 0x46]); // "DKIF"
  v.setUint16(4, 0, true); // version
  v.setUint16(6, 32, true); // header size
  h.set([0x56, 0x50, 0x39, 0x30], 8); // "VP90"
  v.setUint16(12, width, true);
  v.setUint16(14, height, true);
  v.setUint32(16, fps, true); // timebase denominator
  v.setUint32(20, 1, true); // timebase numerator
  v.setUint32(24, frameCount, true);
  return h;
}

/** 12-byte IVF frame header: u32 payload size + u64 pts (both LE). */
export function ivfFrameHeader(size: number, frameIndex: number): Uint8Array {
  const h = new Uint8Array(12);
  const v = new DataView(h.buffer);
  v.setUint32(0, size, true);
  v.setUint32(4, frameIndex, true); // pts low word (frame counts stay small)
  v.setUint32(8, 0, true); // pts high word
  return h;
}
