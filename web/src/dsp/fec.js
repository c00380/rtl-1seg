// ISDB-T RS(204,188), interleaving and energy dispersal, GPL-3.0-or-later.
export { ReedSolomon } from './reed-solomon.js';

export function depuncture(coded) {
  const out = new Float32Array(Math.floor(coded.length / 3) * 4);
  for (let i = 0, j = 0; j < out.length; i += 3, j += 4) {
    out[j] = coded[i];
    out[j + 1] = coded[i + 1];
    out[j + 3] = coded[i + 2];
  }
  return out;
}

export class ByteDeinterleaver {
  constructor() {
    this.buffers = Array.from({ length: 12 }, (_, k) => new Uint8Array(17 * (11 - k)));
    this.positions = new Uint16Array(12);
    this.branch = 0;
  }
  push(byte) {
    const branch = this.branch,
      buffer = this.buffers[branch];
    this.branch = (branch + 1) % 12;
    if (!buffer.length) return byte;
    const position = this.positions[branch],
      out = buffer[position];
    buffer[position] = byte;
    this.positions[branch] = position + 1 === buffer.length ? 0 : position + 1;
    return out;
  }
}

// One complete PRBS reset period (64 blocks) is immutable and reusable at lock time.
export const energySequence = new Uint8Array(64 * 204);
for (let i = 0, reg = 0xa9; i < energySequence.length; i++) {
  let byte = 0;
  for (let j = 0; j < 8; j++) {
    const feedback = ((reg >> 13) ^ (reg >> 14)) & 1;
    reg = ((reg << 1) | feedback) & 0x7fff;
    byte = (byte << 1) | feedback;
  }
  energySequence[i] = byte;
}

export function packBits(bits) {
  const out = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < out.length; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i * 8 + j];
    out[i] = byte;
  }
  return out;
}
export function bestSyncPhase(bytes) {
  let phase = 0,
    score = 0;
  for (let p = 0; p < 204; p++) {
    let hits = 0,
      total = 0;
    for (let i = p; i < bytes.length; i += 204) {
      if (bytes[i] === 0x47 || bytes[i] === 0xb8) hits++;
      total++;
    }
    const value = total ? hits / total : 0;
    if (value >= score) {
      score = value;
      phase = p;
    }
  }
  return { phase, score };
}
