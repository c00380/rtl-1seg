import { FFT } from './fft.js';
import {
  FFT_LEN,
  DATA_CARRIERS,
  SEGMENT_CARRIERS,
  SEGMENT_OFFSET,
  TMCC_CARRIERS,
  AC_CARRIERS,
  FREQUENCY_PERMUTATION,
  PILOT_SIGNS,
} from './layout.js';
// IQ synchronization, FFT and carrier recovery. GPL-3.0-or-later.
// Preserve the input power floor with unnormalized FFT amplitudes.
const MIN_PILOT_POWER = 1.024e-9;
const TWO_PI = 2 * Math.PI;
const pilotReciprocals = Float32Array.from(
  PILOT_SIGNS.subarray(0, SEGMENT_CARRIERS),
  (sign) => (sign * 3) / 4,
);
export const pilotIndices = Array.from({ length: 4 }, (_, phase) =>
  Uint16Array.from({ length: 36 }, (_, i) => phase * 3 + i * 12),
);
export const dataIndices = pilotIndices.map((pilots) => {
  const excluded = new Set([...pilots, ...TMCC_CARRIERS, ...AC_CARRIERS]);
  return Uint16Array.from(
    Array.from({ length: SEGMENT_CARRIERS }, (_, i) => i).filter((i) => !excluded.has(i)),
  );
});

// Incremental CP correlation reuses sample products in a sliding window.
function cpWindows(iq, start, count, cp, visit) {
  if (count < FFT_LEN + cp) return;
  let re = 0,
    im = 0,
    power = 0;
  const term = new Float32Array(3);
  // Reuse the rounded products when each sample leaves the sliding window.
  const ring = new Float32Array(cp * 3);
  function read(j) {
    const a = (start + j) * 2,
      b = a + FFT_LEN * 2;
    const ar = iq[a],
      ai = iq[a + 1],
      br = iq[b],
      bi = iq[b + 1];
    term[0] = ar * br + ai * bi;
    term[1] = ai * br - ar * bi;
    term[2] = (ar * ar + ai * ai + (br * br + bi * bi)) * 0.5;
  }
  for (let j = 0; j < cp; j++) {
    read(j);
    ring.set(term, j * 3);
    re += term[0];
    im += term[1];
    power += term[2];
  }
  visit(0, re, im, power);
  for (let d = 1; d <= count - FFT_LEN - cp; d++) {
    read(d + cp - 1);
    const nr = term[0],
      ni = term[1],
      np = term[2];
    const slot = ((d - 1) % cp) * 3;
    term[0] = ring[slot];
    term[1] = ring[slot + 1];
    term[2] = ring[slot + 2];
    ring[slot] = nr;
    ring[slot + 1] = ni;
    ring[slot + 2] = np;
    re += nr - term[0];
    im += ni - term[1];
    power += np - term[2];
    visit(d, re, im, power);
  }
}
const metric = (re, im, power) => (power > 0 ? Math.sqrt(re * re + im * im) / power : 0);
export function estimateSync(iq, start, count) {
  let guard = 32,
    bestPeriod = -Infinity;
  // Retain each guard's maximum while folding, avoiding a second CP scan.
  const candidates = new Map();
  for (const cp of [256, 128, 64, 32]) {
    const period = FFT_LEN + cp;
    const fold = new Float32Array(period),
      counts = new Uint32Array(period);
    let candidate = null;
    cpWindows(iq, start, count, cp, (d, re, im, power) => {
      const index = d % period;
      const value = metric(re, im, power);
      fold[index] = fold[index] + value;
      if (!candidate || value > candidate.metric)
        candidate = { start: d, cp, metric: value, cfo: -Math.atan2(im, re) / TWO_PI };
      counts[index]++;
    });
    candidates.set(cp, candidate);
    let score = 0;
    if (count - FFT_LEN - cp + 1 >= 2 * period) {
      for (let i = 0; i < period; i++) {
        if (counts[i]) score = Math.max(score, fold[i] / counts[i]);
      }
    }
    if (score >= bestPeriod) {
      guard = cp;
      bestPeriod = score;
    }
  }
  return candidates.get(guard);
}

export function trackSync(iq, count, cp, expected, symbols = 16, radius = 4) {
  const period = FFT_LEN + cp;
  if (expected < radius || expected + radius + symbols * period > count) return null;
  let best = null;
  for (let start = expected - radius; start <= expected + radius; start++) {
    let re = 0,
      im = 0,
      power = 0;
    for (let s = 0; s < symbols; s++) {
      for (let j = 0; j < cp; j++) {
        const a = (start + s * period + j) * 2,
          b = a + FFT_LEN * 2;
        const ar = iq[a],
          ai = iq[a + 1],
          br = iq[b],
          bi = iq[b + 1];
        re += ar * br + ai * bi;
        im += ai * br - ar * bi;
        power += (ar * ar + ai * ai + (br * br + bi * bi)) * 0.5;
      }
    }
    const value = metric(re, im, power);
    if (power > 1e-12 && Number.isFinite(value) && value >= 0.3 && (!best || value > best.metric)) {
      best = { start, metric: value, cfo: -Math.atan2(im, re) / TWO_PI };
    }
  }
  return best;
}

export class OfdmDemod {
  constructor() {
    this.fft = new FFT(FFT_LEN);
    this.input = new Float64Array(FFT_LEN * 2);
    this.work = new Float64Array(FFT_LEN * 2);
    this.spectrum = new Float32Array(FFT_LEN * 2);
    this.rotation = new Float32Array(FFT_LEN * 2);
    this.rotationCfo = NaN;
  }
  process(iq, start, cp, cfo) {
    const work = this.input,
      out = this.spectrum;
    const rotation = this.rotation;
    // Reuse oscillator coefficients until CFO changes.
    if (this.rotationCfo !== cfo) {
      this.rotationCfo = cfo;
      const angle = (-TWO_PI * cfo) / FFT_LEN;
      const wr = Math.cos(angle),
        wi = Math.sin(angle);
      let pr = 1,
        pi = 0;
      for (let k = 0; k < FFT_LEN * 2; k += 2) {
        rotation[k] = pr;
        rotation[k + 1] = pi;
        const nr = pr * wr - pi * wi;
        pi = pr * wi + pi * wr;
        pr = nr;
      }
    }
    for (let target = 0; target < FFT_LEN * 2; target += 2) {
      const source = (start + cp) * 2 + target;
      const re = iq[source],
        im = iq[source + 1];
      const pr = rotation[target],
        pi = rotation[target + 1];
      work[target] = re * pr - im * pi;
      work[target + 1] = re * pi + im * pr;
    }
    this.fft.transform(this.work, work);
    for (let k = 0; k < FFT_LEN; k++) {
      const target = ((k + FFT_LEN / 2) & (FFT_LEN - 1)) * 2;
      out[target] = this.work[k * 2];
      out[target + 1] = this.work[k * 2 + 1];
    }
    return out;
  }
}

export function detectPhase(spectrum, scores = null) {
  let bestPhase = 0,
    best = -Infinity;
  for (let phase = 0; phase < 4; phase++) {
    let re = 0,
      im = 0,
      den = 0,
      prevRe = 0,
      prevIm = 0,
      prevMagnitude = 0,
      first = true;
    for (const index of pilotIndices[phase]) {
      const source = (index + SEGMENT_OFFSET) * 2;
      const hr = spectrum[source] * pilotReciprocals[index],
        hi = spectrum[source + 1] * pilotReciprocals[index];
      const magnitude = Math.hypot(hr, hi);
      if (!first) {
        re += hr * prevRe + hi * prevIm;
        im += hi * prevRe - hr * prevIm;
        den += magnitude * prevMagnitude;
      }
      first = false;
      prevRe = hr;
      prevIm = hi;
      prevMagnitude = magnitude;
    }
    const score = den < MIN_PILOT_POWER ? 0 : Math.hypot(re, im) / den;
    if (scores) scores[phase] = score;
    if (score >= best) {
      best = score;
      bestPhase = phase;
    }
  }
  return bestPhase;
}

export class CarrierSymbol {
  constructor() {
    this.channel = new Float32Array(SEGMENT_CARRIERS * 2);
    this.equalized = new Float32Array(SEGMENT_CARRIERS * 2);
    this.data = new Float32Array(DATA_CARRIERS * 2);
    this.frequency = new Float32Array(DATA_CARRIERS * 2);
  }
  process(spectrum, phase) {
    const sp = pilotIndices[phase],
      h = this.channel,
      eq = this.equalized;
    for (const index of sp) {
      const source = (index + SEGMENT_OFFSET) * 2;
      h[index * 2] = spectrum[source] * pilotReciprocals[index];
      h[index * 2 + 1] = spectrum[source + 1] * pilotReciprocals[index];
    }
    for (let k = 0; k < sp.length - 1; k++) {
      const a = sp[k],
        b = sp[k + 1];
      for (let index = a + 1; index < b; index++) {
        const t = (index - a) / 12,
          left = 1 - t;
        h[index * 2] = h[a * 2] * left + h[b * 2] * t;
        h[index * 2 + 1] = h[a * 2 + 1] * left + h[b * 2 + 1] * t;
      }
    }
    const first = sp[0],
      last = sp[35];
    for (let component = 0; component < 2; component++) {
      const slopeLeft = (h[sp[1] * 2 + component] - h[first * 2 + component]) / 12;
      const slopeRight = (h[last * 2 + component] - h[sp[34] * 2 + component]) / 12;
      for (let i = 0; i < first; i++)
        h[i * 2 + component] = h[first * 2 + component] + slopeLeft * (i - first);
      for (let i = last + 1; i < SEGMENT_CARRIERS; i++)
        h[i * 2 + component] = h[last * 2 + component] + slopeRight * (i - last);
    }
    for (let i = 0; i < SEGMENT_CARRIERS; i++) {
      const p = i * 2,
        s = (i + SEGMENT_OFFSET) * 2,
        hr = h[p],
        hi = h[p + 1];
      const power = hr * hr + hi * hi;
      eq[p] = power < MIN_PILOT_POWER ? 0 : (spectrum[s] * hr + spectrum[s + 1] * hi) / power;
      eq[p + 1] = power < MIN_PILOT_POWER ? 0 : (spectrum[s + 1] * hr - spectrum[s] * hi) / power;
    }
    const data = this.data,
      frequency = this.frequency,
      indices = dataIndices[phase];
    for (let i = 0; i < DATA_CARRIERS; i++) {
      data[i * 2] = eq[indices[i] * 2];
      data[i * 2 + 1] = eq[indices[i] * 2 + 1];
    }
    for (let i = 0; i < DATA_CARRIERS; i++) {
      const source = FREQUENCY_PERMUTATION[i] * 2;
      frequency[i * 2] = data[source];
      frequency[i * 2 + 1] = data[source + 1];
    }
  }
}

export class TimeDeinterleaver {
  constructor(interleave = 4) {
    this.latency = interleave * 95;
    this.delays = Uint16Array.from(
      { length: DATA_CARRIERS },
      (_, c) => interleave * (95 - ((5 * c) % 96)),
    );
    this.offsets = new Uint32Array(DATA_CARRIERS);
    this.positions = new Uint16Array(DATA_CARRIERS);
    let total = 0;
    for (let c = 0; c < DATA_CARRIERS; c++) {
      this.offsets[c] = total;
      total += this.delays[c] * 2;
    }
    this.buffer = new Float32Array(total);
    this.output = new Float32Array(DATA_CARRIERS * 2);
  }
  push(data) {
    const out = this.output;
    for (let c = 0; c < DATA_CARRIERS; c++) {
      const delay = this.delays[c],
        source = c * 2;
      if (!delay) {
        out[source] = data[source];
        out[source + 1] = data[source + 1];
        continue;
      }
      const position = this.positions[c],
        index = this.offsets[c] + position * 2;
      out[source] = this.buffer[index];
      out[source + 1] = this.buffer[index + 1];
      this.buffer[index] = data[source];
      this.buffer[index + 1] = data[source + 1];
      this.positions[c] = position + 1 === delay ? 0 : position + 1;
    }
    return out;
  }
}
export const softValue = (value) => (Number.isFinite(value) ? Math.max(-8, Math.min(8, value)) : 0);
export class BitDeinterleaver {
  constructor() {
    this.buffer = new Float32Array(120);
    this.position = 0;
    this.msb = 0;
    this.lsb = 0;
  }
  push(re, im) {
    this.msb = this.buffer[this.position];
    this.lsb = softValue(-im);
    this.buffer[this.position] = softValue(-re);
    if (++this.position === 120) this.position = 0;
  }
}
