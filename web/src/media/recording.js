import { messages } from '../messages.js';
import { convertRecording } from './recording-conversion-client.js';
import { createRecordingStorage } from './recording-storage.js';

// Stop before slow storage can turn the write queue into another recording buffer.
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

export function recordingTime(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return seconds >= 3600
    ? `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
    : `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}
export function recordingFilename(name, date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const stamp = `${values.year}${values.month}${values.day}-${values.hour}${values.minute}${values.second}`;
  const title =
    (name || messages.recording.defaultName)
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
      .replace(/[.\s]+$/g, '')
      .slice(0, 80) || messages.recording.defaultName;
  return `${title}_${stamp}.ts`;
}
export function downloadRecording(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      release();
    }, 60000);
  }
  return { released };
}

// Save the ordered TS chunks transferred by the DSP worker without decoding them.
export class Recording {
  static supported() {
    return (
      typeof Blob === 'function' &&
      typeof globalThis.URL?.createObjectURL === 'function' &&
      typeof globalThis.navigator?.storage?.getDirectory === 'function'
    );
  }
  constructor({
    onState = () => {},
    onError = () => {},
    onSaved = () => {},
    download = downloadRecording,
    convert = convertRecording,
    createStorage = createRecordingStorage,
    now = () => performance.now(),
    interval = (fn, ms) => setInterval(fn, ms),
    clear = (timer) => clearInterval(timer),
    timeout = (fn, ms) => setTimeout(fn, ms),
    clearTimeout: cancelTimeout = (timer) => clearTimeout(timer),
  } = {}) {
    Object.assign(this, {
      onState,
      onError,
      onSaved,
      download,
      convert,
      createStorage,
      now,
      interval,
      clear,
      timeout,
      cancelTimeout,
    });
    this.sequence = 0;
    this.session = null;
  }
  get active() {
    return this.session !== null;
  }
  get saving() {
    return this.session?.saving ?? false;
  }
  async start({ worker, name = messages.recording.defaultName, format = 'ts' }) {
    if (this.session) return;
    if (!worker) throw new Error(messages.recording.unsupported);
    const s = {
      id: ++this.sequence,
      worker,
      filename: recordingFilename(name, new Date()),
      format,
      started: this.now(),
      saving: false,
      finished: false,
      accepting: true,
      bytes: 0,
      pendingBytes: 0,
      startedRecording: false,
    };
    s.done = new Promise((resolve) => {
      s.resolve = resolve;
    });
    this.session = s;
    s.ready = Promise.resolve().then(() => this.createStorage());
    s.writes = Promise.resolve();
    this.notify(s);
    try {
      s.storage = await s.ready;
      if (s.saving) return;
      worker.postMessage({ type: 'recording-start', id: s.id });
      s.startedRecording = true;
      s.timer = this.interval(() => this.notify(s), 1000);
    } catch (error) {
      this.clear(s.timer);
      await s.storage?.dispose().catch(() => {});
      this.session = null;
      this.onState({ active: false, saving: false, elapsed: 0 });
      s.resolve();
      throw error;
    }
    this.notify(s);
  }
  receive(message) {
    const s = this.session;
    if (!s || s.id !== message.id || s.finished) return;
    if (message.type === 'recording-data' && s.accepting) {
      const bytes = new Uint8Array(message.buf);
      if (!bytes.length) return;
      if (s.pendingBytes + bytes.length > MAX_PENDING_BYTES) {
        s.accepting = false;
        this.onError(messages.recording.storageSlow);
        void this.stop();
        return;
      }
      s.pendingBytes += bytes.length;
      s.writes = s.writes.then(async () => {
        try {
          if (!s.writeFailed) await s.storage.write(bytes);
        } catch {
          s.writeFailed = true;
          s.accepting = false;
          this.onError(messages.recording.storageWriteFailed);
          void this.stop();
        } finally {
          s.pendingBytes -= bytes.length;
        }
      });
      s.bytes += bytes.length;
    } else if (message.type === 'recording-stopped') void this.finish(s);
  }
  notify(s) {
    this.onState({ active: true, saving: s.saving, elapsed: this.now() - s.started });
  }
  stop() {
    const s = this.session;
    if (!s) return Promise.resolve();
    if (!s.saving) {
      s.saving = true;
      this.clear(s.timer);
      this.notify(s);
      if (!s.startedRecording) {
        void this.finish(s);
        return s.done;
      }
      // A crashed or unresponsive worker must not prevent channel changes/stop.
      s.stopTimer = this.timeout(() => this.interrupt(), 10000);
      try {
        s.worker.postMessage({ type: 'recording-stop', id: s.id });
      } catch {
        this.interrupt();
      }
    }
    return s.done;
  }
  interrupt() {
    const s = this.session;
    if (!s || s.finished) return;
    this.onError(messages.recording.interrupted);
    void this.finish(s);
  }
  async finish(s) {
    if (s.finished) return;
    s.finished = true;
    s.saving = true;
    this.clear(s.timer);
    this.cancelTimeout(s.stopTimer);
    this.notify(s);
    let released;
    try {
      s.storage = await s.ready;
      await s.writes;
      const blob = await s.storage.file();
      if (!s.bytes) {
        if (s.startedRecording) this.onError(messages.recording.noData);
        return;
      }
      if (!blob.size) throw new Error(messages.recording.noData);
      let savedBlob = blob;
      let filename = s.filename;
      if (s.format === 'mp4') {
        try {
          savedBlob = await this.convert(blob, await s.storage.output('mp4'));
          filename = filename.replace(/\.ts$/, '.mp4');
        } catch {
          // Keep the received programme when a damaged/incomplete TS cannot be remuxed.
          this.onError(messages.recording.conversionFallback);
        }
      }
      const download = await this.download(savedBlob, filename);
      released = download?.released;
      this.onSaved({ filename, bytes: savedBlob.size });
    } catch {
      this.onError(messages.recording.saveFailed);
    } finally {
      const dispose = () =>
        s.storage?.dispose().catch(() => {
          this.onError(messages.recording.storageCleanupFailed);
        });
      // File-backed object URLs must remain readable until the download URL is released.
      if (released) void released.then(dispose);
      else await dispose();
      if (this.session === s) this.session = null;
      this.onState({ active: false, saving: false, elapsed: 0 });
      s.resolve();
    }
  }
}
