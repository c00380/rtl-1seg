import { TMCC_CARRIERS, AC_CARRIERS } from './layout.js';
// Read-only TMCC/AC observer, ported from physical.rs. GPL-3.0-or-later.
const MAX_AGE = 204 * 3;
export const TMCC_GENERATOR = [
  82, 77, 76, 71, 67, 66, 56, 52, 48, 40, 36, 34, 24, 22, 18, 10, 4, 0,
].reduce((value, bit) => value | (1n << BigInt(bit)), 0n);
export function remainder(bits, polynomial, degree) {
  let value = 0n;
  const high = 1n << BigInt(degree);
  for (const bit of bits) {
    value = (value << 1n) | BigInt(bit);
    if (value & high) value ^= polynomial;
  }
  return value;
}
function ringSync(ring, cursor) {
  let value = 0;
  for (let i = 1; i <= 16; i++) value = (value << 1) | ring[(cursor + i) % 204];
  return value === 0x35ee || value === 0xca11;
}
export class PhysicalInformation {
  constructor() {
    this.previous = new Float32Array(24);
    this.hasPrevious = false;
    this.tmccRing = new Uint8Array(204);
    this.acRing = new Uint8Array(204);
    this.tmcc = new Uint8Array(204);
    this.ac = new Uint8Array(204);
    this.tmccCandidate = new Uint8Array(204);
    this.acCandidate = new Uint8Array(204);
    this.cursor = 0;
    this.count = 0;
    this.hasTmcc = false;
    this.acKind = 0;
    this.tmccAge = MAX_AGE;
    this.acAge = MAX_AGE;
  }
  observe(equalized) {
    let t = 0,
      a = 0,
      valid = true;
    for (let group = 0; group < 2; group++) {
      let sum = 0;
      const indices = group ? AC_CARRIERS : TMCC_CARRIERS;
      for (let i = 0; i < indices.length; i++) {
        const source = indices[i] * 2,
          target = (group ? 8 : 0) + i * 2;
        const re = equalized[source],
          im = equalized[source + 1];
        if (this.hasPrevious) {
          const oldRe = this.previous[target],
            oldIm = this.previous[target + 1];
          const dr = re * oldRe + im * oldIm,
            di = im * oldRe - re * oldIm;
          const amplitude = Math.hypot(dr, di);
          if (!Number.isFinite(amplitude) || amplitude <= 1e-12) valid = false;
          else sum += dr / amplitude;
        }
        this.previous[target] = re;
        this.previous[target + 1] = im;
      }
      if (group) a = Number(sum < 0);
      else t = Number(sum < 0);
    }
    if (this.hasPrevious) {
      if (valid) this.pushBits(t, a);
      else {
        this.count = 0;
        this.tmccAge = MAX_AGE;
        this.acAge = MAX_AGE;
      }
    }
    this.hasPrevious = true;
  }
  pushBits(t, a) {
    this.tmccAge = Math.min(MAX_AGE, this.tmccAge + 1);
    this.acAge = Math.min(MAX_AGE, this.acAge + 1);
    this.tmccRing[this.cursor] = t;
    this.acRing[this.cursor] = a;
    this.cursor = (this.cursor + 1) % 204;
    this.count = Math.min(204, this.count + 1);
    if (this.count < 204) return;
    const tc = ringSync(this.tmccRing, this.cursor),
      ac = ringSync(this.acRing, this.cursor);
    if (!tc && !ac) return;
    const tf = this.tmccCandidate,
      af = this.acCandidate;
    for (let i = 0; i < 204; i++) {
      const p = (this.cursor + i) % 204;
      tf[i] = this.tmccRing[p];
      af[i] = this.acRing[p];
    }
    if (tc && remainder(tf.subarray(20), TMCC_GENERATOR, 82) === 0n) {
      this.tmcc.set(tf);
      this.hasTmcc = true;
      this.tmccAge = 0;
      if (!ac) {
        this.acKind = af.subarray(1).every((bit) => bit === 1) ? 1 : 3;
        this.ac.set(af);
        this.acAge = 0;
      }
    }
    if (ac) {
      const valid =
        remainder(af.subarray(17), TMCC_GENERATOR, 82) === 0n &&
        remainder(af.subarray(21, 122), 0x633n, 10) === 0n;
      this.acKind = valid ? 2 : 4;
      this.ac.set(af);
      this.acAge = 0;
    }
  }
  snapshot() {
    const bytes = new Uint8Array(412);
    bytes[0] = 1;
    bytes[1] = Number(this.hasTmcc && this.tmccAge < MAX_AGE);
    bytes[2] = this.acAge < MAX_AGE ? this.acKind : 0;
    bytes.set(this.tmcc, 4);
    bytes.set(this.ac, 208);
    return bytes;
  }
}
