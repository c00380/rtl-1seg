import { withTimeout } from './async-operation.js';
import { messages } from '../messages.js';

// One owner for reception resources and exclusive UI operations. Even failed
// cleanup releases every other resource and restores the operation controls.
export class ReceptionSession {
  device = null;
  mediaWorker = null;
  demodWorker = null;
  generation = 0;
  audioContext = null;
  timingTimer = null;
  pcmNode = null;
  gainNode = null;
  readTask = null;
  running = false;
  audioPlaying = false;
  lastFrame = 0;
  transportReady = false;
  stopping = null;
  recovering = null;

  constructor({ saveRecording, usbReceiver, onChange, onReset }) {
    Object.assign(this, { saveRecording, usbReceiver, onChange, onReset });
  }
  get busy() {
    return this.running || this.recovering !== null;
  }
  async run(operation) {
    if (this.busy) return;
    this.running = true;
    try {
      this.onChange();
      return await operation();
    } finally {
      this.running = false;
      this.onChange();
    }
  }
  stop() {
    if (!this.stopping)
      this.stopping = this.cleanup().finally(() => {
        this.stopping = null;
      });
    return this.stopping;
  }
  recover(error, report) {
    if (this.recovering) return this.recovering;
    this.recovering = Promise.resolve()
      .then(async () => {
        this.onChange();
        let cleanupError;
        try {
          await this.stop();
        } catch (failure) {
          cleanupError = failure;
        }
        report(error, cleanupError);
      })
      .finally(() => {
        this.recovering = null;
        this.onChange();
      });
    return this.recovering;
  }
  async cleanup() {
    let failure;
    const attempt = async (operation) => {
      try {
        await operation();
      } catch (error) {
        failure ??= error;
      }
    };
    await attempt(this.saveRecording);
    const { device, mediaWorker, demodWorker, audioContext, readTask, timingTimer } = this;
    this.device = this.mediaWorker = this.demodWorker = this.audioContext = this.readTask = null;
    this.pcmNode = this.gainNode = this.timingTimer = null;
    this.audioPlaying = this.transportReady = false;
    this.lastFrame = 0;
    await attempt(() => demodWorker?.terminate());
    await attempt(() => mediaWorker?.terminate());
    clearInterval(timingTimer);
    if (audioContext) audioContext.onstatechange = null;
    await attempt(() => (device || (this.usbReceiver.device && this.usbReceiver))?.close());
    if (readTask)
      await attempt(() =>
        withTimeout(() => readTask.catch(() => {}), messages.reception.responseTimeout),
      );
    await attempt(() => audioContext?.close());
    await attempt(this.onReset);
    if (failure) throw failure;
  }
}
