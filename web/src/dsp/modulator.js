import { IqResampler, IQ_SAMPLE_RATE as SAMPLE_RATE } from './iq-formats.js';
export { IqResampler, SAMPLE_RATE };
// ISDB-T Mode 3, central segment, QPSK 2/3, I=4. GPL-3.0-or-later.
// Uses the receiver's immutable carrier/FEC definitions; owns all transmit state.
import { FFT } from './fft.js';
import { FREQUENCY_PERMUTATION, TMCC_CARRIERS, AC_CARRIERS, PILOT_SIGNS } from './layout.js';
import { nullPacket } from '../broadcast/transport.js';
import { energySequence } from './fec.js';
import { encodeRs } from './reed-solomon.js';
export { encodeRs };
import { TMCC_GENERATOR, remainder } from './physical.js';
import { dataIndices, pilotIndices } from './front-end.js';

export const SYMBOLS_PER_FRAME = 204;
export const NULL_PACKET = nullPacket();
export const transportBitrate = (guard = 8) =>
  (64 * 188 * 8 * SAMPLE_RATE) / (204 * (1024 + 1024 / guard));

class Delay {
  constructor(length, Type = Uint8Array) {
    this.buffer = new Type(length);
    this.position = 0;
  }
  push(value) {
    if (!this.buffer.length) return value;
    const old = this.buffer[this.position];
    this.buffer[this.position] = value;
    this.position = (this.position + 1) % this.buffer.length;
    return old;
  }
}
const parity = (value) => {
  value ^= value >> 4;
  value ^= value >> 2;
  value ^= value >> 1;
  return value & 1;
};
export function tmccFrame(frameIndex = 0) {
  const bits = new Uint8Array(204).fill(1);
  function put(start, width, value) {
    for (let i = 0; i < width; i++) bits[start + i] = (value >>> (width - i - 1)) & 1;
  }
  put(0, 1, 0);
  put(1, 16, frameIndex & 1 ? 0xca11 : 0x35ee);
  put(17, 3, 7);
  put(20, 2, 0);
  put(22, 4, 15);
  put(26, 1, 0);
  put(27, 1, 1);
  for (const start of [28, 68]) {
    put(start, 3, 1);
    put(start + 3, 3, 1);
    put(start + 6, 3, 3);
    put(start + 9, 4, 1);
  }
  put(67, 1, 1);
  put(107, 3, 7);
  bits.fill(0, 122);
  const check = remainder(bits.subarray(20), TMCC_GENERATOR, 82);
  for (let i = 0; i < 82; i++) bits[122 + i] = Number((check >> BigInt(81 - i)) & 1n);
  return bits;
}
const pilot = Float64Array.from(PILOT_SIGNS, (sign) => (sign * 4) / 3);
export class OneSegModulator {
  constructor({ guard = 8, amplitude = 0.1 } = {}) {
    if (![4, 8, 16, 32].includes(guard)) throw new Error('Guard must be 4, 8, 16 or 32');
    if (!Number.isFinite(amplitude) || amplitude <= 0 || amplitude > 1)
      throw new Error('Amplitude must be in (0,1]');
    this.guard = guard;
    this.cp = 1024 / guard;
    this.amplitude = amplitude;
    this.rs = new Uint8Array(204);
    this.scrambled = new Uint8Array(204);
    this.bytePosition = 204;
    this.packetIndex = 0;
    // Byte interleaving + complementary receiver delay = exactly one frame (64 TSPs).
    this.frameDelay = new Delay((64 - 11) * 204);
    this.byteDelays = Array.from({ length: 12 }, (_, branch) => new Delay(branch * 17));
    this.branch = 0;
    this.state = 0;
    this.coded = new Uint8Array(768);
    this.lsbDelay = new Delay(120);
    // 380 + 28 + complementary receiver delays = two OFDM frames.
    this.time = Array.from({ length: 384 }, (_, c) => {
      const delay = 4 * ((5 * c) % 96) + 28;
      return {
        i: new Delay(delay, Float64Array),
        q: new Delay(delay, Float64Array),
      };
    });
    this.fft = new FFT(1024);
    this.spectrum = new Float64Array(2048);
    this.wave = new Float64Array(2048);
    this.samples = new Float32Array((1024 + this.cp) * 2);
    this.symbol = 0;
    this.tmcc = tmccFrame();
    this.tmccSign = 1;
    this.acSign = 1;
  }
  nextByte(nextPacket) {
    if (this.bytePosition === 204) {
      encodeRs(nextPacket(), this.rs);
      const phase = (this.packetIndex++ % 64) * 204;
      for (let j = 0; j < 203; j++) this.scrambled[j] = this.rs[j + 1] ^ energySequence[phase + j];
      this.scrambled[203] = this.rs[0];
      this.bytePosition = 0;
    }
    const delayed = this.frameDelay.push(this.scrambled[this.bytePosition++]);
    const byte = this.byteDelays[this.branch].push(delayed);
    this.branch = (this.branch + 1) % 12;
    return byte;
  }
  nextSymbol(nextPacket = () => NULL_PACKET) {
    let coded = 0;
    for (let byte = 0; byte < 64; byte++) {
      const value = this.nextByte(nextPacket);
      for (let bit = 7; bit >= 0; bit--) {
        const reg = ((value >>> bit) & 1) * 64 + this.state;
        if (bit & 1) this.coded[coded++] = parity(reg & 0o171);
        this.coded[coded++] = parity(reg & 0o133);
        this.state = reg >>> 1;
      }
    }
    const phase = this.symbol & 3,
      indices = dataIndices[phase],
      out = this.spectrum;
    out.fill(0);
    const put = (carrier, re, im = 0) => {
      const bin = ((carrier - 216 + 1024) & 1023) * 2;
      out[bin] = re;
      out[bin + 1] = im;
    };
    for (let c = 0; c < 384; c++) {
      const re = (1 - 2 * this.coded[c * 2]) * Math.SQRT1_2;
      const im = (1 - 2 * this.lsbDelay.push(this.coded[c * 2 + 1])) * Math.SQRT1_2;
      const delay = this.time[c];
      put(indices[FREQUENCY_PERMUTATION[c]], delay.i.push(re), delay.q.push(im));
    }
    for (const carrier of pilotIndices[phase]) put(carrier, pilot[carrier]);
    put(432, pilot[432]);
    const frameSymbol = this.symbol % 204;
    if (frameSymbol === 0) {
      this.tmcc = tmccFrame(Math.floor(this.symbol / 204));
      this.tmccSign = 1;
      this.acSign = 1;
    } else {
      if (this.tmcc[frameSymbol]) this.tmccSign = -this.tmccSign;
      this.acSign = -this.acSign;
    }
    for (const carrier of TMCC_CARRIERS) put(carrier, pilot[carrier] * this.tmccSign);
    for (const carrier of AC_CARRIERS) put(carrier, pilot[carrier] * this.acSign);
    this.fft.inverseTransform(this.wave, out);
    const scale = 32 * this.amplitude;
    for (let n = 0; n < 1024 + this.cp; n++) {
      const source = ((n - this.cp + 1024) & 1023) * 2;
      this.samples[n * 2] = this.wave[source] * scale;
      this.samples[n * 2 + 1] = this.wave[source + 1] * scale;
    }
    this.symbol++;
    return this.samples;
  }
}

export function packIq(samples, format) {
  const sizes = { s8: 1, s16: 2, f32: 4 },
    size = sizes[format];
  if (!size) throw new Error('IQ format must be s8, s16 or f32');
  const bytes = new Uint8Array(samples.length * size);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    if (!Number.isFinite(value) || Math.abs(value) > 1)
      throw new Error('IQ exceeds full scale; reduce --amplitude');
    if (format === 's8') view.setInt8(i, Math.max(-128, Math.min(127, Math.round(value * 128))));
    else if (format === 's16')
      view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(value * 32768))), true);
    else view.setFloat32(i * 4, value, true);
  }
  return bytes;
}
