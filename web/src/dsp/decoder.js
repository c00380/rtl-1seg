import { FFT_LEN, DATA_CARRIERS } from './layout.js';
import {
  CarrierSymbol,
  TimeDeinterleaver,
  BitDeinterleaver,
  OfdmDemod,
  estimateSync,
  trackSync,
  detectPhase,
  pilotIndices,
} from './front-end.js';
import {
  depuncture,
  ReedSolomon,
  ByteDeinterleaver,
  energySequence,
  packBits,
  bestSyncPhase,
} from './fec.js';
import { Viterbi } from './viterbi.js';
import { PhysicalInformation } from './physical.js';
// Browser-native live IQ → MPEG-TS. Port of stream.rs, GPL-3.0-or-later.
const LOCK_SYMBOLS = 1200;
const WARMUP = 380 + 120;
const BYTE_LATENCY = 2244;
const NEED_INIT = (LOCK_SYMBOLS + 8) * 1280 + 60000;
const MAX_SYMBOLS_PER_CALL = 64;
const COMPACT_AT = 8 * 1024 * 1024;
const iqScale = 1 / 127.5;
const iqValues = Float32Array.from({ length: 256 }, (_, i) => (i - 127.5) * iqScale);

function lockParameters(iq, start, cp, cfo, phase0, demod) {
  const carriers = new CarrierSymbol(),
    time = new TimeDeinterleaver(),
    bit = new BitDeinterleaver();
  const coded = new Float32Array((LOCK_SYMBOLS - WARMUP) * DATA_CARRIERS * 2);
  let position = 0;
  // Demodulate once, retain only soft bits rather than 1200 entire FFT spectra.
  for (let k = 0; k < LOCK_SYMBOLS; k++) {
    carriers.process(demod.process(iq, start + k * (FFT_LEN + cp), cp, cfo), (phase0 + k) & 3);
    const data = time.push(carriers.frequency);
    for (let c = 0; c < DATA_CARRIERS; c++) {
      bit.push(data[c * 2], data[c * 2 + 1]);
      if (k >= WARMUP) {
        coded[position++] = bit.msb;
        coded[position++] = bit.lsb;
      }
    }
  }
  const viterbi = new Viterbi();
  let bytes;
  try {
    bytes = packBits(viterbi.decode(depuncture(coded)));
  } finally {
    viterbi.free();
  }
  if (bytes.length < 12 + BYTE_LATENCY + 408) return null;
  const rs = new ReedSolomon(),
    block = new Uint8Array(204);
  let bestScore = 0,
    best = null;
  for (let commutator = 0; commutator < 12; commutator++) {
    const di = new ByteDeinterleaver();
    const stream = new Uint8Array(bytes.length - commutator - BYTE_LATENCY);
    for (let j = 0; j < bytes.length - commutator; j++) {
      const value = di.push(bytes[j + commutator]);
      if (j >= BYTE_LATENCY) stream[j - BYTE_LATENCY] = value;
    }
    const { phase, score } = bestSyncPhase(stream);
    if (score < 0.9) continue;
    const blocks = Math.min(128, Math.floor((stream.length - phase) / 204));
    for (let reset = 0; reset < 64; reset++) {
      let ok = 0,
        prbs = 0;
      for (let index = 0; index < blocks; index++) {
        if (index % 64 === reset) prbs = 0;
        const offset = phase + index * 204;
        block[0] = stream[offset];
        for (let j = 1; j < 204; j++) block[j] = stream[offset + j] ^ energySequence[prbs + j - 1];
        prbs += 204;
        if (rs.isCodeword(block) || rs.decode(block)) ok++;
        // A candidate unable to improve the incumbent cannot affect lock selection.
        if (ok + blocks - index - 1 <= bestScore * blocks) break;
      }
      const fraction = ok / Math.max(1, blocks);
      if (fraction > bestScore) {
        bestScore = fraction;
        best = { commutator, reset, phase };
      }
      if (bestScore === 1) return best;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

class Pipe {
  constructor({ commutator, reset, phase }) {
    this.carriers = new CarrierSymbol();
    this.time = new TimeDeinterleaver();
    this.bit = new BitDeinterleaver();
    this.physical = new PhysicalInformation();
    this.viterbi = new Viterbi(96);
    this.bytes = new ByteDeinterleaver();
    this.rs = new ReedSolomon();
    this.commutator = commutator;
    this.reset = reset;
    this.blockPhase = phase;
    this.depuncturePosition = 0;
    this.softBlock = new Float32Array((DATA_CARRIERS * 8) / 3);
    this.softCount = 0;
    this.bitAccumulator = 0;
    this.bitCount = 0;
    this.byteIn = 0;
    this.byteOut = 0;
    this.block = new Uint8Array(204);
    this.descrambled = new Uint8Array(204);
    this.blockLength = 0;
    this.blockIndex = 0;
    this.prbs = 0;
    this.quality = new Float64Array(4).fill(NaN);
    this.rsCounts = new Float64Array(4);
    this.failedRun = 0;
    this.validBlocks = 0;
  }
  diagnostics(phase) {
    const { data, channel } = this.carriers;
    const ideal = Math.SQRT1_2;
    let error = 0,
      low = Infinity,
      high = 0,
      pilotError = 0,
      pilotPower = 0;
    for (let i = 0; i < data.length; i += 2) {
      const dx = Math.abs(data[i]) - ideal,
        dy = Math.abs(data[i + 1]) - ideal;
      error += dx * dx + dy * dy;
    }
    error /= DATA_CARRIERS;
    for (let i = 0; i < channel.length; i += 2) {
      const power = channel[i] * channel[i] + channel[i + 1] * channel[i + 1];
      low = Math.min(low, power);
      high = Math.max(high, power);
    }
    const sp = pilotIndices[phase];
    for (let i = 1; i < sp.length - 1; i++) {
      const a = sp[i - 1] * 2,
        b = sp[i] * 2,
        c = sp[i + 1] * 2;
      const dr = channel[b] - (channel[a] + channel[c]) * 0.5;
      const di = channel[b + 1] - (channel[a + 1] + channel[c + 1]) * 0.5;
      pilotError += dr * dr + di * di;
      pilotPower += channel[b] * channel[b] + channel[b + 1] * channel[b + 1];
    }
    this.quality[0] = 100 * Math.sqrt(error);
    this.quality[1] = -10 * Math.log10(Math.max(1e-20, error));
    this.quality[2] = low > 0 ? 10 * Math.log10(high / low) : NaN;
    this.quality[3] = pilotPower > 0 ? 100 * Math.sqrt(pilotError / pilotPower) : NaN;
  }
  process(spectrum, phase0, k, out) {
    const phase = (phase0 + k) & 3;
    this.carriers.process(spectrum, phase);
    this.physical.observe(this.carriers.equalized);
    this.diagnostics(phase);
    const data = this.time.push(this.carriers.frequency);
    this.softCount = 0;
    for (let c = 0; c < DATA_CARRIERS; c++) {
      this.bit.push(data[c * 2], data[c * 2 + 1]);
      if (k < WARMUP) continue;
      this.keptSoft(this.bit.msb);
      this.keptSoft(this.bit.lsb);
    }
    if (this.softCount)
      for (const bit of this.viterbi.push(this.softBlock)) this.decodedBit(bit, out);
  }
  keptSoft(value) {
    // Rate 2/3 keeps mother-code positions 0,1,3; one symbol fills this buffer.
    if (this.depuncturePosition === 2) {
      this.softBlock[this.softCount++] = 0;
      this.depuncturePosition++;
    }
    this.softBlock[this.softCount++] = value;
    this.depuncturePosition = (this.depuncturePosition + 1) & 3;
  }
  decodedBit(bit, out) {
    this.bitAccumulator = ((this.bitAccumulator << 1) | bit) & 255;
    if (++this.bitCount < 8) return;
    const byte = this.bitAccumulator;
    this.bitAccumulator = 0;
    this.bitCount = 0;
    if (this.byteIn++ < this.commutator) return;
    const valueOut = this.bytes.push(byte);
    if (this.byteOut++ < BYTE_LATENCY + this.blockPhase) return;
    this.block[this.blockLength++] = valueOut;
    if (this.blockLength < 204) return;
    if (this.blockIndex % 64 === this.reset) this.prbs = 0;
    const ds = this.descrambled;
    ds[0] = this.block[0];
    for (let j = 1; j < 204; j++) ds[j] = this.block[j] ^ energySequence[this.prbs + j - 1];
    this.prbs += 204;
    this.blockIndex++;
    this.blockLength = 0;
    this.rsCounts[0]++;
    const corrected = this.rs.decode(ds);
    if (!corrected) {
      this.rsCounts[1]++;
      this.failedRun++;
      return;
    }
    this.failedRun = 0;
    this.validBlocks++;
    let changes = 0;
    for (let j = 0; j < 204; j++) if (corrected[j] !== ds[j]) changes++;
    if (changes) {
      this.rsCounts[2]++;
      this.rsCounts[3] += changes;
    }
    out.set(corrected.subarray(0, 188), out.used);
    out.used += 188;
  }
}

export class StreamingDecoder {
  constructor() {
    this.demod = new OfdmDemod();
    this.buffer = new Float32Array(NEED_INIT * 2);
    this.length = 0;
    this.pending = -1;
    this.dcRe = 0;
    this.dcIm = 0;
    this.dcDone = false;
    this.cursor = 0;
    this.symbols = 0;
    this.locked = null;
    this.pipe = null;
    this.syncMetric = 0;
    this.timingShift = 0;
    this.nextLock = NEED_INIT;
    this.phaseScores = new Float64Array(4);
    this.phaseMismatch = 0;
    this.recovery = null;
  }
  reserve(samples) {
    if ((this.length + samples) * 2 > this.buffer.length) {
      if (this.cursor)
        this.compact(Math.max(0, this.cursor - 16 * (this.locked?.period || 1280) - 4));
      if ((this.length + samples) * 2 > this.buffer.length) {
        const buffer = new Float32Array(
          Math.max(this.buffer.length * 2, (this.length + samples) * 2),
        );
        buffer.set(this.buffer.subarray(0, this.length * 2));
        this.buffer = buffer;
      }
    }
  }
  append(iq) {
    const samples = Math.floor((iq.length + Number(this.pending >= 0)) / 2);
    this.reserve(samples);
    let source = 0,
      target = this.length * 2;
    const dr = this.dcDone ? this.dcRe : 0,
      di = this.dcDone ? this.dcIm : 0;
    if (this.pending >= 0 && iq.length) {
      this.buffer[target++] = iqValues[this.pending] - dr;
      this.buffer[target++] = iqValues[iq[source++]] - di;
      this.pending = -1;
    }
    while (source + 1 < iq.length) {
      this.buffer[target++] = iqValues[iq[source++]] - dr;
      this.buffer[target++] = iqValues[iq[source++]] - di;
    }
    if (source < iq.length) this.pending = iq[source];
    this.length = target / 2;
  }
  appendFloat(iq) {
    if (iq.length % 2 || this.pending >= 0) throw new Error('Incomplete floating point IQ pair');
    this.reserve(iq.length / 2);
    const dr = this.dcDone ? this.dcRe : 0,
      di = this.dcDone ? this.dcIm : 0;
    let target = this.length * 2;
    for (let source = 0; source < iq.length; source += 2) {
      this.buffer[target++] = iq[source] - dr;
      this.buffer[target++] = iq[source + 1] - di;
    }
    this.length = target / 2;
  }
  compact(samples) {
    this.buffer.copyWithin(0, samples * 2, this.length * 2);
    this.length -= samples;
    this.cursor = Math.max(0, this.cursor - samples);
  }
  tryLock() {
    if (this.length < this.nextLock) return;
    // Failed acquisition retries at most once per 204-symbol frame, not every network chunk.
    this.nextLock = this.length + 204 * 1280;
    if (!this.dcDone) {
      let re = 0,
        im = 0;
      for (let i = 0; i < this.length * 2; i += 2) {
        re += this.buffer[i];
        im += this.buffer[i + 1];
      }
      this.dcRe = re / this.length;
      this.dcIm = im / this.length;
      for (let i = 0; i < this.length * 2; i += 2) {
        this.buffer[i] -= this.dcRe;
        this.buffer[i + 1] -= this.dcIm;
      }
      this.dcDone = true;
    }
    const offset = Math.min(Math.floor(this.length / 10), 50000);
    const est = estimateSync(this.buffer, offset, Math.min(64 * 1280, this.length - offset));
    if (!est || est.metric <= 1e-12) return;
    const period = FFT_LEN + est.cp,
      start = offset + (est.start % period);
    if (Math.floor((this.length - start) / period) < LOCK_SYMBOLS) return;
    const cfo = est.cfo,
      phase0 = detectPhase(this.demod.process(this.buffer, start, est.cp, cfo));
    const parameters = lockParameters(this.buffer, start, est.cp, cfo, phase0, this.demod);
    if (!parameters) return;
    this.compact(start);
    this.locked = { cp: est.cp, cfo, period, phase0 };
    this.syncMetric = est.metric;
    this.pipe = new Pipe(parameters);
    const keep = 800 * period,
      frame = 204 * period;
    if (this.length > keep) this.compact(Math.floor((this.length - keep) / frame) * frame);
    this.cursor = 0;
    this.symbols = 0;
  }
  push(iq) {
    this.append(iq);
    this.acquire();
  }
  pushFloat(iq) {
    this.appendFloat(iq);
    this.acquire();
  }
  acquire() {
    if (!this.locked) {
      this.tryLock();
      if (!this.locked && this.length > NEED_INIT * 1.5) {
        this.compact(this.length - NEED_INIT);
        this.nextLock = NEED_INIT + 204 * 1280;
      }
    }
  }
  backlog() {
    return this.locked
      ? Math.max(0, Math.floor((this.length - this.cursor - 4) / this.locked.period))
      : 0;
  }
  takeRecovery() {
    const recovery = this.recovery;
    this.recovery = null;
    return recovery;
  }
  reacquire(reason) {
    // Keep all unprocessed input. Discarding it here would manufacture another gap.
    this.compact(this.cursor);
    this.recovery = { reason, symbols: this.symbols, rsFailed: this.pipe.failedRun };
    this.locked = null;
    this.pipe.viterbi.free();
    this.pipe = null;
    this.symbols = 0;
    this.phaseMismatch = 0;
    this.nextLock = NEED_INIT;
  }
  pump() {
    if (!this.locked || !this.backlog()) return new Uint8Array(0);
    const out = new Uint8Array((Math.ceil((MAX_SYMBOLS_PER_CALL * 64) / 204) + 1) * 188);
    out.used = 0;
    const lock = this.locked;
    for (let n = 0; n < MAX_SYMBOLS_PER_CALL && this.cursor + lock.period + 4 <= this.length; n++) {
      if (this.symbols % 32 === 0 && this.cursor >= 16 * lock.period + 4) {
        const expected = this.cursor - 16 * lock.period;
        const est = trackSync(this.buffer, this.length, lock.cp, expected);
        if (est) {
          const shift = Math.max(-2, Math.min(2, est.start - expected));
          this.cursor += shift;
          this.timingShift += shift;
          this.syncMetric = est.metric;
          const delta = est.cfo - lock.cfo + 0.5;
          const wrapped = (((delta % 1) + 1) % 1) - 0.5;
          lock.cfo += 0.1 * wrapped;
        }
      }
      const spectrum = this.demod.process(this.buffer, this.cursor, lock.cp, lock.cfo);
      this.pipe.process(spectrum, lock.phase0, this.symbols, out);
      if (this.symbols % 32 === 0) {
        const actual = detectPhase(spectrum, this.phaseScores);
        const expected = (lock.phase0 + this.symbols) & 3;
        const mismatch =
          actual !== expected &&
          this.phaseScores[actual] > 0.75 &&
          this.phaseScores[actual] - this.phaseScores[expected] > 0.2;
        this.phaseMismatch = mismatch ? this.phaseMismatch + 1 : 0;
      }
      this.cursor += lock.period;
      this.symbols++;
      // CP correlation alone cannot detect a dropped OFDM symbol. Require
      // previously decoded RS blocks and sustained independent evidence of loss.
      if (
        (this.pipe.validBlocks >= 16 && this.phaseMismatch >= 3 && this.pipe.failedRun >= 64) ||
        this.pipe.failedRun >= 512
      ) {
        this.reacquire(this.phaseMismatch >= 3 ? 'pilot-phase-slip' : 'rs-lock-loss');
        break;
      }
      if (this.cursor >= COMPACT_AT) this.compact(this.cursor - 16 * lock.period - 4);
    }
    return out.slice(0, out.used);
  }
  constellation() {
    return this.pipe ? this.pipe.carriers.data.slice() : new Float32Array(0);
  }
  physical_information() {
    return this.pipe ? this.pipe.physical.snapshot() : new Uint8Array(0);
  }
  signal_monitor() {
    if (!this.locked) return new Float64Array(0);
    const lock = this.locked,
      cfo = ((((lock.cfo + 0.5) % 1) + 1) % 1) - 0.5;
    return Float64Array.from([
      1,
      FFT_LEN,
      lock.cp,
      cfo,
      this.syncMetric,
      this.symbols,
      this.timingShift,
      this.backlog(),
      (lock.phase0 + Math.max(0, this.symbols - 1)) & 3,
      ...this.pipe.quality,
      ...this.pipe.rsCounts,
    ]);
  }
  free() {
    this.buffer = new Float32Array(0);
    this.length = 0;
    this.cursor = 0;
    this.pipe?.viterbi.free();
    this.pipe = null;
    this.demod = null;
    this.locked = null;
    this.pending = -1;
  }
}
