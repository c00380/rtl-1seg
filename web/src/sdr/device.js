import { messages } from '../messages.js';
import { CHANNELS } from '../app/channels.js';
export const SDR_SAMPLE_RATE = 1015873;
const BLOCK_SAMPLES = 65536;
export const QUEUED_TRANSFERS = 8;

// Keep the provider's USB selection across stop/start, retuning and channel scans.
// Each close releases the hardware; provider.get() can reopen the same selection.
export class RtlSdrDevice {
  constructor(provider) {
    this.provider = provider;
    this.device = null;
    this.opening = null;
    this.closing = null;
    this.stopped = true;
    this.skipBytes = 0;
  }

  // The UI has already authorized and selected this provider's USB device.
  async select() {
    if (this.closing) await this.closing;
    if (this.device) return;
    if (this.opening) return this.opening;
    this.opening = this.provider
      .get()
      .then((device) => {
        this.device = device;
      })
      .catch(async (error) => {
        // get() may fail after opening USB, before returning the initialized tuner.
        await this.provider.device?.close().catch(() => {});
        // A disconnected or unsupported choice can be replaced on the next click.
        this.provider.device = undefined;
        throw error;
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  async open({ channel, gain }) {
    const frequency = CHANNELS.find((value) => value.channel === channel)?.hz;
    await this.select();
    const device = this.device;
    try {
      await device.setSampleRate(SDR_SAMPLE_RATE);
      await device.setFrequencyCorrection(0);
      await device.setCenterFrequency(frequency);
      await device.setGain(gain);
      await device.resetBuffer();
      if (this.device !== device || this.closing)
        throw new DOMException(messages.usb.cancelled, 'AbortError');
      this.skipBytes = Math.floor(SDR_SAMPLE_RATE / 4) * 2;
      this.stopped = false;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async readSamples(callback) {
    if (!this.device || this.stopped) throw new Error(messages.usb.disconnected);
    const device = this.device;
    // WebUSB executes transfers to one endpoint in submission order. Keep the
    // hardware supplied while UI work runs; settle errors immediately, including
    // requests cancelled by close() that the loop will never consume.
    const request = () => {
      try {
        return Promise.resolve(device.readSamples(BLOCK_SAMPLES)).then(
          (block) => ({ block }),
          (error) => ({ error }),
        );
      } catch (error) {
        return Promise.resolve({ error });
      }
    };
    const transfers = Array.from({ length: QUEUED_TRANSFERS }, request);
    let head = 0;
    try {
      while (!this.stopped && this.device === device) {
        const { block, error } = await transfers[head];
        if (this.stopped || this.device !== device) break;
        if (error) throw error;
        // Submit the replacement before invoking any synchronous display work.
        transfers[head] = request();
        head = (head + 1) % QUEUED_TRANSFERS;
        const bytes = new Uint8Array(block.data);
        if (!bytes.length || bytes.length % 2) throw new Error(messages.usb.noData);
        const skip = Math.min(this.skipBytes, bytes.length);
        this.skipBytes -= skip;
        if (skip < bytes.length) callback(bytes.subarray(skip));
      }
    } catch (error) {
      if (!this.stopped) throw error;
    }
  }

  async close() {
    this.stopped = true;
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.opening?.catch(() => {});
      const device = this.device;
      this.device = null;
      try {
        await device?.close();
      } finally {
        // Closing the raw USB device also cancels an outstanding transferIn.
        try {
          await this.provider?.device?.close();
        } catch {
          /* Already closed or disconnected. */
        }
      }
    })().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }
}
