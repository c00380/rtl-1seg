import { messages } from '../messages.js';
import { CHANNELS } from './channels.js';
const STORAGE_KEY = '1seg.remote-channels.v1';
const abortError = () =>
  Object.assign(new Error(messages.registration.cancelled), { name: 'AbortError' });
const validChannel = (value) =>
  Number.isInteger(value) && CHANNELS.some((item) => item.channel === value);
function entry(value) {
  if (
    !value ||
    !Number.isInteger(value.remoteKey) ||
    value.remoteKey < 1 ||
    value.remoteKey > 12 ||
    !validChannel(value.channel)
  )
    return null;
  return {
    remoteKey: value.remoteKey,
    channel: value.channel,
    stationName: typeof value.stationName === 'string' ? value.stationName.slice(0, 128) : '',
  };
}
function registeredChannels(values) {
  const found = new Map();
  for (const value of values) {
    const candidate = entry(value);
    if (candidate && !found.has(candidate.remoteKey)) found.set(candidate.remoteKey, candidate);
  }
  return [...found.values()].sort((a, b) => a.remoteKey - b.remoteKey);
}
export function strongestChannels(values) {
  const found = new Map();
  for (const value of values) {
    const candidate = entry(value);
    if (!candidate || !Number.isFinite(value.power) || value.power < 1e-12 || value.power > 10)
      continue;
    const previous = found.get(candidate.remoteKey);
    if (
      !previous ||
      value.power > previous.power ||
      (value.power === previous.power && candidate.channel < previous.entry.channel)
    )
      found.set(candidate.remoteKey, { entry: candidate, power: value.power });
  }
  return [...found.values()].map((value) => value.entry).sort((a, b) => a.remoteKey - b.remoteKey);
}
export class ChannelRegistry {
  constructor(storage) {
    this.storage = storage;
    this.entries = [];
    try {
      const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
      if (saved?.version === 1 && Array.isArray(saved.channels)) {
        this.entries = registeredChannels(saved.channels);
        if (JSON.stringify(saved.channels) !== JSON.stringify(this.entries))
          this.save(this.entries);
      }
    } catch {
      /* Keep normalized entries in this tab if reading or updating storage fails. */
    }
  }
  save(values) {
    this.entries = registeredChannels(values);
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, channels: this.entries }));
    } catch {
      throw new Error(messages.registration.saveFailed);
    }
  }
  find(remoteKey) {
    return this.entries.find((value) => value.remoteKey === remoteKey);
  }
}

// One tuner, sequential probes. Commit only a completed scan; cancellation and
// receiver errors leave the previous browser registration intact.
export async function scanChannels({ probe, signal, onProgress = () => {}, channels = CHANNELS }) {
  const found = [];
  for (const [index, { channel }] of channels.entries()) {
    if (signal.aborted) throw abortError();
    onProgress({
      index: index + 1,
      total: channels.length,
      channel,
      found: strongestChannels(found).length,
    });
    const result = await probe(channel, signal);
    if (signal.aborted) throw abortError();
    if (result?.channel === channel) found.push(result);
  }
  return strongestChannels(found);
}

// Identify stations from CRC-validated service tables, without waiting for a
// video keyframe. Compare several power samples at the same fixed tuner gain.
export class ScanReception {
  constructor(channel, { acceptInformation = () => true } = {}) {
    this.channel = channel;
    this.acceptInformation = acceptInformation;
    this.frames = 0;
    this.levels = [];
    this.information = null;
    this.synchronized = false;
  }
  observeProgram(information) {
    this.information = information;
    if (information) this.observeSynchronization(true);
    this.check();
  }
  observeFrame() {
    this.frames++;
    this.observeSynchronization(true);
    this.check();
  }
  observeSynchronization(locked) {
    if (locked && !this.synchronized) {
      this.synchronized = true;
      this.extend?.();
    }
  }
  observeLevel(db) {
    if (this.information?.remoteKey && Number.isFinite(db)) {
      this.levels.push(10 ** (db / 10));
      this.check();
    }
  }
  reset() {
    this.frames = 0;
    this.levels = [];
    this.information = null;
    this.synchronized = false;
  }
  check() {
    if (this.information && !this.acceptInformation(this.information)) {
      this.finish?.(null);
      return;
    }
    if (
      this.information?.stationIdentified === false ||
      !this.information?.stationName?.trim() ||
      this.levels.length < 3
    )
      return;
    const result = entry({
      channel: this.channel,
      remoteKey: this.information?.remoteKey,
      stationName: this.information?.stationName,
    });
    const power = this.levels.reduce((a, b) => a + b, 0) / this.levels.length;
    if (result && power >= 1e-12 && power <= 10) this.finish?.({ ...result, power });
  }
  fail(error) {
    this.failure = error;
    this.finish?.(null, error);
  }
  wait(signal, timeout = 8000) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const abort = () => this.finish(null, abortError());
      let timer = setTimeout(() => this.finish(null), timeout);
      this.extend = () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.finish(null), timeout);
      };
      this.finish = (result, error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.finish = null;
        this.extend = null;
        error ? reject(error) : resolve(result);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (this.failure) this.finish(null, this.failure);
      else this.check();
    });
  }
}
