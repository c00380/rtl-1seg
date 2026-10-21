import { messages } from '../messages.js';
import { DataState } from './state.js';
const PANEL_KEYS = {
  ArrowUp: 1,
  ArrowDown: 2,
  ArrowLeft: 3,
  ArrowRight: 4,
  Enter: 18,
  Backspace: 19,
  '*': 101,
  '#': 102,
};

export class DataView {
  constructor(panel) {
    this.host = panel.querySelector('.rx-data-screen');
    this.status = panel.querySelector('[data-data-status]');
    this.state = new DataState();
    this.session = 0;
    this.opened = false;
    this.ready = false;
    this.loaded = false;
    panel.querySelectorAll('[data-bml-key]').forEach((button) =>
      button.addEventListener('click', () => {
        this.send({ action: 'key', key: Number(button.dataset.bmlKey) });
      }),
    );
    panel.querySelector('[data-data-reload]').addEventListener('click', () => this.mount());
    panel.addEventListener('keydown', (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const key =
        PANEL_KEYS[event.key] ?? (/^[0-9]$/.test(event.key) ? Number(event.key) + 5 : null);
      if (key === 18 && event.target.closest('button,summary')) return;
      if (key != null) {
        event.preventDefault();
        if (!event.repeat) this.send({ action: 'key', key });
      }
    });
    window.addEventListener('message', (event) => {
      if (
        event.origin !== location.origin ||
        event.source !== this.frame?.contentWindow ||
        event.data?.session !== this.session
      )
        return;
      if (event.data.type === 'bml-ready') {
        clearTimeout(this.startupTimer);
        this.failed = false;
        this.ready = true;
        this.send({ action: 'messages', messages: this.state.snapshot() });
      } else if (event.data.type === 'bml-loaded') {
        this.failed = false;
        this.loaded = true;
        this.status.textContent = messages.data.displaying;
      } else if (event.data.type === 'bml-status') {
        if (event.data.text === messages.data.pageFailed) {
          clearTimeout(this.startupTimer);
          this.failed = true;
        }
        this.status.textContent = event.data.text;
      }
    });
    this.reset();
  }
  send(message) {
    if (this.ready)
      this.frame?.contentWindow.postMessage({ ...message, session: this.session }, location.origin);
  }
  mount() {
    clearTimeout(this.startupTimer);
    this.failed = false;
    this.session++;
    this.ready = false;
    this.loaded = false;
    this.frame?.remove();
    this.frame = null;
    if (!this.opened) return;
    const frame = document.createElement('iframe');
    frame.title = messages.data.pageTitle;
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.src = new URL(`../../data-frame.html#${this.session}`, import.meta.url).href;
    this.host.replaceChildren(frame);
    this.frame = frame;
    const session = this.session;
    this.startupTimer = setTimeout(() => {
      if (this.session !== session || this.ready) return;
      this.failed = true;
      this.status.textContent = messages.data.pageFailed;
    }, 20000);
    this.updateStatus();
  }
  open(opened) {
    if (this.opened === opened) return;
    this.opened = opened;
    this.mount();
  }
  reset() {
    this.state.reset();
    this.status.textContent = messages.data.waiting;
    this.mount();
  }
  updateStatus() {
    if (this.failed) {
      this.status.textContent = messages.data.pageFailed;
      return;
    }
    const pmt = this.state.messages.get('pmt');
    const available = pmt?.components.some(
      (c) => c.componentId === 0x80 && c.streamType === 0x0d && c.dataComponentId === 0x0d,
    );
    if (pmt && !available) this.loaded = false;
    if (this.loaded) return;
    this.status.textContent = !pmt
      ? messages.data.waiting
      : !available
        ? messages.data.unavailable
        : messages.data.loading;
    if (available && this.state.lists.get(0x80)?.modules.length === 0)
      this.status.textContent = messages.data.notBroadcast;
  }
  receive(batch) {
    const accepted = batch.filter((message) => this.state.accept(message));
    const forwarded = accepted.filter((m) => m.type !== 'dataError');
    if (forwarded.length) this.send({ action: 'messages', messages: forwarded });
    this.updateStatus();
    if (accepted.some((m) => m.type === 'dataError') && !this.loaded && !this.failed)
      this.status.textContent = messages.data.incomplete;
  }
}
