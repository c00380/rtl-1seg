// Shared offline/browser IQ rate conversion. GPL-3.0-or-later.
import { getIqResampler, makeLowPassKernel } from '../../vendor/signals.js';
import { messages } from '../messages.js';
export const IQ_SAMPLE_RATE = 64000000 / 63;

export const IQ_FORMATS = { u8: 1, s8: 1, s16: 2, f32: 4 };
export function iqSettings({ format = 'u8', sampleRate = IQ_SAMPLE_RATE } = {}) {
  if (!Object.hasOwn(IQ_FORMATS, format)) throw new Error(messages.iqFile.invalidFormat);
  sampleRate = Number(sampleRate);
  if (!Number.isFinite(sampleRate) || sampleRate < 1) throw new Error(messages.iqFile.invalidRate);
  iqRatio(Math.abs(sampleRate - IQ_SAMPLE_RATE) < 1 ? IQ_SAMPLE_RATE : sampleRate, IQ_SAMPLE_RATE);
  return { format, sampleRate };
}
export function decodeIq(bytes, format) {
  if (!Object.hasOwn(IQ_FORMATS, format)) throw new Error(messages.iqFile.invalidFormat);
  const size = IQ_FORMATS[format];
  const output = new Float32Array(Math.floor(bytes.length / (size * 2)) * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let j = 0; j < output.length; j++) {
    const value =
      format === 'u8'
        ? (view.getUint8(j) - 127.5) * (1 / 127.5)
        : format === 's8'
          ? view.getInt8(j) / 128
          : format === 's16'
            ? view.getInt16(j * 2, true) / 32768
            : view.getFloat32(j * 4, true);
    output[j] = value;
  }
  return output;
}

// Exact small rational factors keep the library's polyphase kernels bounded.
// Only floating-point evaluation error is tolerated; rates are never approximated.
function iqRatio(from, to) {
  const ratio = to / from;
  let value = ratio,
    a = 0,
    b = 1,
    c = 1,
    d = 0;
  for (let step = 0; step < 32; step++) {
    const integer = Math.floor(value);
    const up = integer * b + a,
      down = integer * d + c;
    if (up > 2048 || down > 2048) break;
    if (up > 0 && down > 0 && Math.abs(up / down - ratio) <= Number.EPSILON * 4 * ratio)
      return { up, down };
    [a, b, c, d] = [b, up, d, down];
    value = 1 / (value - integer);
  }
  throw new Error(messages.iqFile.unsupportedRate);
}

// Signals owns the FIR coefficients, convolution and history. This adapter owns
// interleaved transport, exact delay alignment, bounded rate factors and EOF.
export class IqResampler {
  constructor(inputRate, outputRate) {
    if (![inputRate, outputRate].every((rate) => Number.isFinite(rate) && rate >= 1))
      throw new Error(messages.iqFile.invalidRate);
    const { up, down } = iqRatio(inputRate, outputRate);
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.total = 0;
    this.output = 0;
    this.ended = false;
    this.converter = null;
    if (inputRate === outputRate) return;
    const center = 24 * Math.max(up, down);
    const kernel = makeLowPassKernel(up * down, 0.45 * Math.min(up, down), 2 * center + 1);
    this.converter = getIqResampler(down, up, { kernel });
    // Prepend whole input frames until the FIR delay lands on a whole output
    // frame; trimming it then preserves the I/Q phase without interpolation.
    let prefix = 0;
    while ((center + prefix * up) % down) prefix++;
    this.skip = (center + prefix * up) / down;
    this.tailFrames = Math.ceil(center / up) + 2;
    if (prefix) this.convert(new Float32Array(prefix * 2));
  }
  static async create(inputRate, outputRate) {
    return new IqResampler(inputRate, outputRate);
  }
  convert(samples) {
    if (!samples.length) return new Float32Array();
    const count = samples.length / 2;
    const i = new Float32Array(count),
      q = new Float32Array(count);
    for (let n = 0; n < count; n++) {
      i[n] = samples[2 * n];
      q[n] = samples[2 * n + 1];
    }
    const [real, imaginary] = this.converter.resample(i, q);
    const skip = Math.min(this.skip, real.length);
    this.skip -= skip;
    // Library arrays come from a pool. Own this copy before transferring it.
    const output = new Float32Array((real.length - skip) * 2);
    for (let n = skip; n < real.length; n++) {
      output[(n - skip) * 2] = real[n];
      output[(n - skip) * 2 + 1] = imaginary[n];
    }
    return output;
  }
  push(samples, final = false) {
    if (this.ended) throw new Error('Resampler already ended');
    if (samples.length % 2) throw new Error('IQ must contain complete I/Q pairs');
    this.total += samples.length / 2;
    this.ended = final;
    if (!this.converter) {
      this.output = this.total;
      return samples;
    }
    const body = this.convert(samples);
    if (!final) {
      this.output += body.length / 2;
      return body;
    }
    try {
      const tail = this.convert(new Float32Array(this.tailFrames * 2));
      const remaining = Math.round((this.total * this.outputRate) / this.inputRate) - this.output;
      if (body.length + tail.length < remaining * 2)
        throw new Error('IQ filter tail is incomplete');
      const output = new Float32Array(Math.max(0, remaining) * 2);
      output.set(body.subarray(0, output.length));
      if (body.length < output.length)
        output.set(tail.subarray(0, output.length - body.length), body.length);
      this.output += output.length / 2;
      return output;
    } finally {
      this.close();
    }
  }
  close() {
    // Signals' WASM instances have no explicit free API; release their owners.
    this.converter = null;
    this.ended = true;
  }
}
