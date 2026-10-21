import { FFT } from './fft.js';
// Passive raw-IQ diagnostics. This module never changes samples sent to the decoder.
export const INPUT_SAMPLE_RATE = 1015873;
const SIZE = 2048,
  CAPACITY = SIZE * 8;
const db = (value) => 10 * Math.log10(Math.max(1e-20, value));
const WINDOW = Float64Array.from(
  { length: SIZE },
  (_, j) => 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (SIZE - 1)),
);
const WINDOW_ENERGY = WINDOW.reduce((energy, weight) => energy + weight * weight, 0);
export class SignalMonitor {
  constructor(sampleRate = INPUT_SAMPLE_RATE) {
    this.sampleRate = sampleRate;
    this.fft = new FFT(SIZE);
    this.fftInput = new Float64Array(SIZE * 2);
    this.fftOutput = new Float64Array(SIZE * 2);
    this.samples = new Float64Array(CAPACITY * 2);
    this.real = new Float64Array(CAPACITY);
    this.imag = new Float64Array(CAPACITY);
    this.spectrum = new Float64Array(SIZE);
    this.position = 0;
    this.count = 0;
    this.total = 0;
    this.pending = null;
  }
  push(bytes) {
    // IQ byte pairs may straddle transport chunks, just as in the DSP input.
    let offset = 0;
    if (this.pending !== null && bytes.length) {
      this.add(this.pending, bytes[0]);
      this.pending = null;
      offset = 1;
    }
    for (; offset + 1 < bytes.length; offset += 2) this.add(bytes[offset], bytes[offset + 1]);
    if (offset < bytes.length) this.pending = bytes[offset];
  }
  add(i, q) {
    this.samples[this.position * 2] = i;
    this.samples[this.position * 2 + 1] = q;
    this.position = (this.position + 1) % CAPACITY;
    this.count = Math.min(CAPACITY, this.count + 1);
    this.total++;
  }
  pushFloat(iq) {
    for (let j = 0; j + 1 < iq.length; j += 2)
      this.add(iq[j] * 128 + 127.5, iq[j + 1] * 128 + 127.5);
  }
  snapshot() {
    const n = this.count;
    if (n < SIZE) return null;
    const real = this.real,
      imag = this.imag;
    let mi = 0,
      mq = 0,
      clipped = 0;
    for (let j = 0; j < n; j++) {
      const p = ((this.position - n + j + CAPACITY) % CAPACITY) * 2,
        i = this.samples[p],
        q = this.samples[p + 1];
      real[j] = (i - 127.5) / 128;
      imag[j] = (q - 127.5) / 128;
      mi += real[j];
      mq += imag[j];
      clipped += Number(i <= 0 || i >= 255) + Number(q <= 0 || q >= 255);
    }
    mi /= n;
    mq /= n;
    let pi = 0,
      pq = 0,
      cross = 0,
      peak = 0;
    for (let j = 0; j < n; j++) {
      real[j] -= mi;
      imag[j] -= mq;
      const x = real[j],
        y = imag[j],
        p = x * x + y * y;
      pi += x * x;
      pq += y * y;
      cross += x * y;
      peak = Math.max(peak, p);
    }
    const power = (pi + pq) / n,
      averages = Math.min(4, Math.floor(n / SIZE));
    const spectrum = this.spectrum;
    spectrum.fill(0);
    for (let frame = 0; frame < averages; frame++) {
      const start = n - (frame + 1) * SIZE;
      const input = this.fftInput,
        output = this.fftOutput;
      for (let j = 0; j < SIZE; j++) {
        input[j * 2] = WINDOW[j] * real[start + j];
        input[j * 2 + 1] = WINDOW[j] * imag[start + j];
      }
      this.fft.transform(output, input);
      for (let k = 0; k < SIZE; k++)
        spectrum[(k + SIZE / 2) % SIZE] +=
          (output[k * 2] ** 2 + output[k * 2 + 1] ** 2) /
          (2 * this.sampleRate * WINDOW_ENERGY * averages);
    }
    let bandPower = 0,
      peakBin = 0;
    for (let k = 0; k < SIZE; k++) {
      if (spectrum[k] > spectrum[peakBin]) peakBin = k;
      if (Math.abs(((k - SIZE / 2) * this.sampleRate) / SIZE) <= 214285.714)
        bandPower += (spectrum[k] * this.sampleRate) / SIZE;
    }
    // Display 512 bins with power averaging, keeping the physical PSD units.
    const plot = Array.from({ length: 512 }, (_, j) => {
      const k = j * 4;
      return db((spectrum[k] + spectrum[k + 1] + spectrum[k + 2] + spectrum[k + 3]) / 4);
    });
    return {
      sampleRate: this.sampleRate,
      count: n,
      totalSamples: this.total,
      windowMs: (n / this.sampleRate) * 1000,
      level: db(power / 2),
      rms: Math.sqrt(power / 2),
      peak: db(peak / 2),
      papr: power > 0 ? db(peak / power) : null,
      dcI: mi,
      dcQ: mq,
      clipPercent: (clipped / (2 * n)) * 100,
      iqPowerRatio: pi > 0 && pq > 0 ? db(pi / pq) : null,
      iqCorrelation: pi > 0 && pq > 0 ? cross / Math.sqrt(pi * pq) : null,
      bandLevel: db(bandPower),
      peakFrequency: ((peakBin - SIZE / 2) * this.sampleRate) / SIZE,
      spectrum: plot,
      fftSize: SIZE,
      fftAverages: averages,
      binHz: this.sampleRate / SIZE,
    };
  }
}

export function readSignalDiagnostics(values, sampleRate = INPUT_SAMPLE_RATE) {
  if (
    values?.length !== 17 ||
    values[0] !== 1 ||
    values[1] !== 1024 ||
    ![32, 64, 128, 256].includes(values[2])
  )
    return null;
  const [
    version,
    fftSize,
    cp,
    cfo,
    correlation,
    symbols,
    shift,
    backlog,
    spPhase,
    evm,
    mer,
    responseSpan,
    pilotError,
    rsBlocks,
    rsFailed,
    rsCorrected,
    rsBytes,
  ] = values;
  if (
    ![
      cfo,
      correlation,
      symbols,
      shift,
      backlog,
      spPhase,
      rsBlocks,
      rsFailed,
      rsCorrected,
      rsBytes,
    ].every(Number.isFinite)
  )
    return null;
  const symbolSamples = fftSize + cp;
  return {
    fftSize,
    cp,
    guard: fftSize / cp,
    cfoHz: (cfo * sampleRate) / fftSize,
    correlation,
    symbols,
    shift,
    backlog,
    spPhase,
    usefulUs: (fftSize / sampleRate) * 1e6,
    guardUs: (cp / sampleRate) * 1e6,
    symbolUs: (symbolSamples / sampleRate) * 1e6,
    frameMs: (symbolSamples / sampleRate) * 204 * 1000,
    spacingHz: sampleRate / fftSize,
    timingPpm: symbols >= 1024 ? (shift / (symbols * symbolSamples)) * 1e6 : null,
    evm,
    mer,
    responseSpan,
    pilotError,
    rsBlocks,
    rsFailed,
    rsCorrected,
    rsBytes,
    rsFailurePercent: rsBlocks ? (rsFailed / rsBlocks) * 100 : null,
  };
}
