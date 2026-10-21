import { expose, wrap, transfer } from '../../vendor/comlink.js';
import { workerRpc } from '../app/worker-rpc.js';
import { messages } from '../messages.js';
import { withTimeout } from '../app/async-operation.js';
import { inputLevel } from '../dsp/input-level.js';
import {
  IqResampler,
  IQ_SAMPLE_RATE,
  IQ_FORMATS,
  iqSettings,
  decodeIq,
} from '../dsp/iq-formats.js';

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException(messages.iqFile.cancelled, 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function readIqFile(
  file,
  settings,
  send,
  {
    signal,
    now = () => performance.now(),
    sleep = delay,
    onProgress = () => {},
    onLevel = () => {},
  } = {},
) {
  const { format, sampleRate } = iqSettings(settings),
    pairBytes = IQ_FORMATS[format] * 2;
  if (!file?.size || file.size % pairBytes) throw new Error(messages.iqFile.incomplete);
  const resampler = await IqResampler.create(
    Math.abs(sampleRate - IQ_SAMPLE_RATE) < 1 ? IQ_SAMPLE_RATE : sampleRate,
    IQ_SAMPLE_RATE,
  );
  try {
    let due = now(),
      samples = 0,
      lastLevel = -Infinity;
    async function emit(iq) {
      if (!iq.length) return;
      if (signal?.aborted) throw new DOMException(messages.iqFile.cancelled, 'AbortError');
      if (now() - lastLevel >= 1000 / 30) {
        onLevel(inputLevel(iq));
        lastLevel = now();
      }
      const count = iq.length / 2;
      await send(iq); // DSP acknowledgement: bounded input, no dropped or reordered samples.
      samples += count;
      due += (count / IQ_SAMPLE_RATE) * 1000;
      if (now() > due + 250) due = now(); // A slow acquisition stalls file playback rather than dropping samples.
      if (due > now()) await sleep(due - now(), signal);
    }
    const blockBytes = Math.floor(65536 / pairBytes) * pairBytes;
    for (let offset = 0; offset < file.size; offset += blockBytes) {
      if (signal?.aborted) throw new DOMException(messages.iqFile.cancelled, 'AbortError');
      const bytes = new Uint8Array(await file.slice(offset, offset + blockBytes).arrayBuffer());
      await emit(resampler.push(decodeIq(bytes, format)));
      onProgress({
        bytes: Math.min(file.size, offset + bytes.length),
        total: file.size,
        seconds: samples / IQ_SAMPLE_RATE,
      });
    }
    await emit(resampler.push(new Float32Array(), true));
    return { samples, seconds: samples / IQ_SAMPLE_RATE };
  } finally {
    resampler.close();
  }
}

// The same module is the dedicated file reader worker entry point.
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  let file, settings, port, waiting, events;
  const exchange = (message, transfers = []) =>
    withTimeout(
      () =>
        new Promise((resolve) => {
          waiting = resolve;
          port.postMessage(message, transfers);
        }),
      messages.iqFile.responseTimeout,
    ).finally(() => {
      waiting = null;
    });
  const control = {
    open(input, options) {
      settings = iqSettings(options);
      if (!input?.size || input.size % (IQ_FORMATS[settings.format] * 2))
        throw new Error(messages.iqFile.invalidSize);
      file = input;
    },
    connect(input) {
      port = input;
      port.onmessage = ({ data }) => {
        if (data.type === 'ack' || data.type === 'ended') waiting?.();
      };
    },
    async read() {
      let progress, level;
      const result = await readIqFile(
        file,
        settings,
        (iq) => exchange({ type: 'iq', format: 'f32', buf: iq.buffer }, [iq.buffer]),
        {
          onProgress: (value) => {
            progress = events.progress(value).catch(() => {});
          },
          onLevel: (value) => {
            level = events.level(value).catch(() => {});
          },
        },
      );
      await Promise.all([progress, level]);
      await exchange({ type: 'iq-end' });
      return result;
    },
  };
  self.onmessage = ({ data }) => {
    if (data.type !== 'control-port') return;
    events = wrap(data.events);
    expose(control, data.port);
  };
}
export class IqFileReceiver {
  constructor(file, settings, { onProgress = () => {}, WorkerClass = globalThis.Worker } = {}) {
    this.kind = 'file';
    this.file = file;
    this.settings = iqSettings(settings);
    this.onProgress = onProgress;
    this.WorkerClass = WorkerClass;
    this.worker = null;
    this.session = null;
    this.reading = null;
    this.ended = false;
  }
  async open() {
    if (this.worker) throw new Error(messages.iqFile.alreadyReading);
    const worker = new this.WorkerClass(new URL('./iq-file.js', import.meta.url), {
      type: 'module',
    });
    this.worker = worker;
    this.ended = false;
    try {
      this.session = workerRpc(
        worker,
        {
          progress: (progress) => {
            if (this.worker === worker) this.onProgress({ type: 'progress', ...progress });
          },
          level: (level) => {
            if (this.worker === worker) this.reading?.callback({ level });
          },
        },
        messages.iqFile.readFailed,
      );
      await this.call('open', this.file, this.settings);
    } catch (error) {
      if (this.worker === worker) await this.close(error);
      throw error;
    }
  }
  call(method, ...args) {
    const session = this.session;
    if (!session) return Promise.reject(new Error(messages.iqFile.startFailed));
    return withTimeout(
      () => session.call(method, ...args),
      messages.iqFile.initializationTimeout,
    ).catch((error) => {
      if (error.name === 'TimeoutError') session.dispose(error);
      throw error;
    });
  }
  async connectDecoder(decoder) {
    const channel = new MessageChannel();
    try {
      decoder.postMessage({ type: 'iq-port', port: channel.port1 }, [channel.port1]);
      await this.call('connect', transfer(channel.port2, [channel.port2]));
    } catch (error) {
      channel.port1.close();
      channel.port2.close();
      throw error;
    }
  }
  async readSamples(callback) {
    const session = this.session;
    if (!session || this.reading) throw new Error(messages.iqFile.startFailed);
    const reading = { callback };
    this.reading = reading;
    try {
      const result = await session.call('read');
      if (this.session === session) this.ended = true;
      return { type: 'ended', ...result };
    } finally {
      if (this.reading === reading) this.reading = null;
    }
  }
  async close(error = new DOMException(messages.iqFile.cancelled, 'AbortError')) {
    this.session?.dispose(error);
    this.session = null;
    this.worker = null;
    this.reading = null;
  }
}
