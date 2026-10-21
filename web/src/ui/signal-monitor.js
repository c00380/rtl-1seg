import { messages } from '../messages.js';
import { escapeHtml as escape, formatNumber as number, setAttribute } from './utils.js';
const section = (title, entries) =>
  `<section class="rx-monitor-section"><h3>${title}</h3><dl>${entries
    .filter(([, v]) => v != null)
    .map(([k, v]) => `<div><dt>${escape(k)}</dt><dd>${escape(v)}</dd></div>`)
    .join('')}</dl></section>`;
export function signalMonitorMarkup(info, context = {}) {
  if (!info) return '';
  const raw = info.input,
    d = info.diagnostics;
  const parts = [];
  if (raw && raw.count > 0)
    parts.push(
      section(messages.monitor.inputSamples, [
        [messages.monitor.inputStrength, number(context.inputLevel ?? raw.level, 1, ' dBFS')],
        [messages.monitor.format, context.format || messages.monitor.unsignedIqFormat],
        [messages.monitor.configuredSampleRate, number(raw.sampleRate, 0, ' sample/s')],
        [messages.monitor.centerFrequency, number(context.frequency / 1e6, 6, ' MHz')],
        [messages.monitor.tunerGain, number(context.gain, 1, ' dB')],
        [messages.monitor.totalSamples, number(raw.totalSamples, 0)],
        [
          messages.monitor.statisticsWindow,
          `${number(raw.count, 0)} sample / ${number(raw.windowMs, 2, ' ms')}`,
        ],
        [messages.monitor.inputPower, number(raw.level, 2, ' dBFS')],
        [messages.monitor.rms, number(raw.rms, 5)],
        [messages.monitor.peakPower, number(raw.peak, 2, ' dBFS')],
        [messages.monitor.peakAverageRatio, number(raw.papr, 2, ' dB')],
        [messages.monitor.dcI, number(raw.dcI, 5)],
        [messages.monitor.dcQ, number(raw.dcQ, 5)],
        [messages.monitor.clipping, number(raw.clipPercent, 4, ' %')],
        [messages.monitor.iqPowerRatio, number(raw.iqPowerRatio, 2, ' dB')],
        [messages.monitor.iqCorrelation, number(raw.iqCorrelation, 4)],
      ]),
      section(messages.monitor.frequencyDistribution, [
        [messages.monitor.bandwidth, number(raw.sampleRate / 1e3, 3, ' kHz')],
        [messages.monitor.centralSegment, messages.monitor.centralRange],
        [messages.monitor.centralPower, number(raw.bandLevel, 2, ' dBFS')],
        [
          messages.monitor.peakFrequency,
          number(raw.peakFrequency / 1e3, 2, messages.monitor.relativeFrequencyUnit),
        ],
        [messages.monitor.fftSize, number(raw.fftSize, 0)],
        [messages.monitor.fftBinSpacing, number(raw.binHz, 2, ' Hz')],
        [messages.monitor.windowAverage, 'Hann / ' + raw.fftAverages + messages.monitor.intervals],
      ]),
    );
  if (d)
    parts.push(
      section(messages.monitor.synchronization, [
        [messages.monitor.demodulationState, messages.monitor.aligned],
        [messages.monitor.processingFftSize, number(d.fftSize, 0)],
        [messages.monitor.guardRatio, `1/${d.guard}`],
        [messages.monitor.cyclicPrefix, number(d.cp, 0, ' sample')],
        [messages.monitor.usefulDuration, number(d.usefulUs, 3, ' µs')],
        [messages.monitor.guardDuration, number(d.guardUs, 3, ' µs')],
        [messages.monitor.symbolDuration, number(d.symbolUs, 3, ' µs')],
        [messages.monitor.frameDuration, number(d.frameMs, 3, ' ms')],
        [messages.monitor.carrierSpacing, number(d.spacingHz, 3, ' Hz')],
        [messages.monitor.fractionalOffset, number(d.cfoHz, 2, ' Hz')],
        [messages.monitor.correlation, number(d.correlation, 4)],
        [messages.monitor.symbols, number(d.symbols, 0)],
        [messages.monitor.pilotPhase, number(d.spPhase, 0)],
        [messages.monitor.timingCorrection, number(d.shift, 0, ' sample')],
        [messages.monitor.timingDrift, number(d.timingPpm, 3, ' ppm')],
        [messages.monitor.backlog, number(d.backlog, 0, ' symbol')],
      ]),
      section(messages.monitor.quality, [
        [messages.monitor.evm, number(d.evm, 2, ' %')],
        [messages.monitor.mer, number(d.mer, 2, ' dB')],
        [messages.monitor.responseSpan, number(d.responseSpan, 2, ' dB')],
        [messages.monitor.pilotError, number(d.pilotError, 2, ' %')],
      ]),
      section(messages.monitor.errorCorrection, [
        [messages.monitor.rsBlocks, number(d.rsBlocks, 0)],
        [messages.monitor.rsFailed, number(d.rsFailed, 0)],
        [messages.monitor.rsFailureRate, number(d.rsFailurePercent, 3, ' %')],
        [messages.monitor.rsCorrected, number(d.rsCorrected, 0)],
        [messages.monitor.rsBytes, number(d.rsBytes, 0)],
      ]),
    );
  return parts.join('');
}

// A history of actual decoder observations; duplicate symbols are not extra measurements.
export class SignalQualityHistory {
  constructor() {
    this.samples = [];
    this.lastSymbol = null;
  }
  update(diagnostics, now) {
    this.samples = this.samples.filter((s) => now - s.at <= 30000);
    if (
      !diagnostics ||
      !Number.isFinite(diagnostics.mer) ||
      diagnostics.symbols === this.lastSymbol
    )
      return;
    this.lastSymbol = diagnostics.symbols;
    this.samples.push({ at: now, value: diagnostics.mer });
    // Retain the full 30 seconds at the monitor's maximum 30 updates per second.
    if (this.samples.length > 1000) this.samples.shift();
  }
  geometry(now) {
    const samples = this.samples.filter((s) => now - s.at <= 30000);
    if (!samples.length) return null;
    const maximum = Math.max(40, Math.ceil(Math.max(...samples.map((s) => s.value)) / 10) * 10);
    const point = (s) => ({
      x: 24 + Math.max(0, 1 - (now - s.at) / 30000) * 128,
      y: 124 - Math.max(0, Math.min(1, s.value / maximum)) * 108,
    });
    const path = samples
      .map((s, i) => {
        const p = point(s);
        return `${i && s.at - samples[i - 1].at < 2000 ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`;
      })
      .join(' ');
    const last = samples.at(-1);
    return { path, maximum, ...point(last), value: last.value };
  }
}

export function spectrumGeometry(input) {
  if (
    (input?.spectrum?.length ?? 0) < 2 ||
    !Number.isFinite(input.sampleRate) ||
    input.sampleRate <= 0
  )
    return null;
  const finite = input.spectrum.filter(Number.isFinite);
  if (!finite.length) return null;
  const maximum = Math.ceil(Math.max(...finite) / 10) * 10,
    minimum = maximum - 60;
  const left = 36,
    right = 312,
    top = 12,
    bottom = 112;
  const path = Array.from(input.spectrum, (v, j) =>
    Number.isFinite(v)
      ? `${j && Number.isFinite(input.spectrum[j - 1]) ? 'L' : 'M'}${(left + (j / (input.spectrum.length - 1)) * (right - left)).toFixed(2)},${(bottom - Math.max(0, Math.min(1, (v - minimum) / 60)) * (bottom - top)).toFixed(2)}`
      : '',
  )
    .filter(Boolean)
    .join(' ');
  const central = (214285.714 / input.sampleRate) * (right - left);
  return {
    path,
    minimum,
    maximum,
    leftBand: 174 - central,
    rightBand: 174 + central,
    halfKhz: input.sampleRate / 2000,
  };
}

// Keep the existing SVG nodes across monitor updates instead of rebuilding the plot.
export function renderConstellation(target, points = []) {
  let count = 0;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i],
      y = points[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 2 || Math.abs(y) > 2) continue;
    let point = target.children[count++];
    if (!point) {
      point = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      point.setAttribute('r', '1.2');
      target.append(point);
    }
    setAttribute(point, 'cx', 110 + x * 45);
    setAttribute(point, 'cy', 110 - y * 45);
  }
  while (target.children.length > count) target.lastElementChild.remove();
}
