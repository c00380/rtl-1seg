import { messages } from '../messages.js';
import { transfer } from '../../vendor/comlink.js';
import { workerRpc } from '../app/worker-rpc.js';
import { withTimeout } from '../app/async-operation.js';
// Only device permission belongs to the UI. USB reads run independently of paint.
export class UsbWorkerReceiver {
  constructor({ responseTimeout } = {}) {
    this.responseTimeout = responseTimeout;
    this.device = null;
    this.selection = null;
    this.worker = null;
    this.session = null;
    this.reading = null;
    this.closing = null;
  }
  async select() {
    if (this.selection) return;
    // requestDevice must be invoked before the click's user activation expires.
    const raw = await navigator.usb.requestDevice({
      filters: [
        { vendorId: 0x0bda, productId: 0x2832 },
        { vendorId: 0x0bda, productId: 0x2838 },
      ],
    });
    this.selection = {
      vendorId: raw.vendorId,
      productId: raw.productId,
      serialNumber: raw.serialNumber,
    };
  }
  ensureWorker() {
    if (this.session) return this.session;
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      type: 'module',
    });
    const session = workerRpc(worker, null, messages.usb.workerStopped);
    session.failure.catch((error) => this.abort(session, error));
    this.session = session;
    this.worker = worker;
    worker.onmessage = ({ data }) => {
      if (this.session !== session) return;
      if (data.type === 'level') {
        this.reading?.callback(new Uint8Array(data.buf));
      } else if (data.type === 'ended') {
        const reading = this.reading;
        this.reading = null;
        if (data.error) reading?.reject(new Error(data.error));
        else reading?.resolve();
      }
    };
    return session;
  }
  call(method, ...args) {
    const session = this.ensureWorker();
    return withTimeout(() => session.call(method, ...args), messages.usb.responseTimeout, {
      timeout: this.responseTimeout,
    }).catch((error) => {
      if (error.name === 'TimeoutError') this.abort(session, error);
      throw error;
    });
  }
  abort(session, error) {
    if (this.session !== session) return;
    this.reading?.reject(error);
    this.reading = null;
    this.device = null;
    this.dispose(session, error);
  }
  dispose(session, error = new DOMException(messages.usb.cancelled, 'AbortError')) {
    if (this.session !== session) return;
    session.dispose(error);
    this.session = null;
    this.worker = null;
  }
  async open(settings) {
    if (this.closing) await this.closing;
    await this.select();
    try {
      await this.call('open', this.selection, settings);
      if (this.closing) throw new DOMException(messages.usb.cancelled, 'AbortError');
      this.device = true;
    } catch (error) {
      this.selection = null;
      await this.close().catch(() => {});
      throw error;
    }
  }
  async connectDecoder(decoderWorker) {
    const channel = new MessageChannel();
    try {
      decoderWorker.postMessage({ type: 'iq-port', port: channel.port1 }, [channel.port1]);
      await this.call('connectDecoder', transfer(channel.port2, [channel.port2]));
    } catch (error) {
      channel.port1.close();
      channel.port2.close();
      throw error;
    }
  }
  readSamples(callback) {
    if (!this.device) return Promise.reject(new Error(messages.usb.disconnected));
    return new Promise((resolve, reject) => {
      this.reading = { callback, resolve, reject, session: this.session };
      const reading = this.reading;
      this.call('read').catch((error) => {
        if (this.reading === reading) this.reading = null;
        reject(error);
      });
    });
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.device = null;
      const session = this.session;
      if (!session) return;
      try {
        await this.call('close');
      } finally {
        this.dispose(session);
        if (this.reading?.session === session) {
          this.reading.resolve();
          this.reading = null;
        }
      }
    })().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }
}
