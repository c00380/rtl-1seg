import { messages } from '../messages.js';

// Mirror the worker-rendered canvas without changing decoding or audio output.
export class PictureInPicture {
  constructor(button, onError) {
    this.button = button;
    this.document = button.ownerDocument;
    this.onError = onError;
    this.supported = Boolean(
      this.document.pictureInPictureEnabled &&
        this.document.defaultView.HTMLVideoElement.prototype.requestPictureInPicture &&
        this.document.defaultView.HTMLCanvasElement.prototype.captureStream,
    );
    this.canvas = null;
    this.video = null;
    this.busy = false;
    button.addEventListener('click', () => void this.toggle());
    this.update();
  }
  update() {
    const active = this.video !== null && this.document.pictureInPictureElement === this.video;
    this.button.hidden = !this.supported;
    this.button.disabled =
      this.busy || (!active && !(this.video?.readyState >= 1 && this.video.videoWidth > 0));
    this.button.setAttribute('aria-pressed', String(active));
    this.button.setAttribute(
      'aria-label',
      active ? messages.common.exitPictureInPicture : messages.common.pictureInPicture,
    );
  }
  setCanvas(canvas) {
    if (!canvas) {
      this.reset();
      return;
    }
    if (canvas === this.canvas || canvas === this.failedCanvas) return;
    this.reset();
    if (!this.supported) return;
    const video = this.document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.hidden = true;
    this.canvas = canvas;
    this.video = video;
    for (const event of [
      'loadedmetadata',
      'resize',
      'emptied',
      'enterpictureinpicture',
      'leavepictureinpicture',
    ])
      video.addEventListener(event, () => {
        if (this.video === video) this.update();
      });
    this.button.parentElement.append(video);
    try {
      video.srcObject = canvas.captureStream();
      void video.play().catch(() => {
        if (this.video === video) this.failed();
      });
    } catch {
      this.failed();
    }
  }
  failed() {
    const canvas = this.canvas;
    this.reset();
    this.failedCanvas = canvas;
    this.onError(messages.app.pictureInPictureFailed);
  }
  async toggle() {
    const video = this.video;
    if (!video || this.button.disabled) return;
    this.busy = true;
    this.update();
    try {
      if (this.document.pictureInPictureElement === video)
        await this.document.exitPictureInPicture();
      else {
        // Call directly from the click handler to preserve user activation.
        await video.requestPictureInPicture();
        // Reception may have stopped while the browser was opening its window.
        if (this.video !== video && this.document.pictureInPictureElement === video)
          await this.document.exitPictureInPicture();
      }
    } catch {
      if (this.video === video) this.onError(messages.app.pictureInPictureFailed);
    } finally {
      if (this.video === video) {
        this.busy = false;
        this.update();
      }
    }
  }
  reset() {
    const video = this.video;
    this.video = null;
    this.canvas = null;
    this.failedCanvas = null;
    this.busy = false;
    if (video) {
      if (this.document.pictureInPictureElement === video)
        void this.document.exitPictureInPicture().catch(() => {});
      video.pause();
      for (const track of video.srcObject?.getTracks() ?? []) track.stop();
      video.srcObject = null;
      video.remove();
    }
    this.update();
  }
}
