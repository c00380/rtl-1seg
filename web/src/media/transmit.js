import { messages } from '../messages.js';
import { downloadBlob } from './recording.js';
// The worker generates IQ; this thread collects chunks for a browser download.
export function installTransmit(app) {
  const dialog = app.querySelector('.rx-transmit-modal');
  const button = app.querySelector('.rx-transmit-button');
  if (!dialog || !button) return;
  const $ = (id) => dialog.querySelector('#' + id),
    form = $('transmit-form'),
    status = $('transmit-status'),
    videoInput = $('transmit-video');
  let active = false,
    choosing = false,
    cancelled = false,
    worker = null,
    rejectGeneration = null,
    abortTimer = null;
  const fields = [...form.querySelectorAll('input,select,textarea')];
  function controls() {
    for (const field of fields) field.disabled = active;
    $('transmit-generate').disabled = active;
    $('transmit-cancel').disabled = !active;
    form.setAttribute('aria-busy', String(active));
    globalThis.receiverUI?.syncMenus?.();
  }
  button.addEventListener('click', () => {
    if (!dialog.open) dialog.showModal();
  });
  dialog.querySelector('[data-transmit-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => button.focus({ preventScroll: true }));
  videoInput.addEventListener('click', async (event) => {
    // A file input's accept attribute cannot name separate file-type filters.
    if (!globalThis.showOpenFilePicker || !globalThis.DataTransfer) return;
    event.preventDefault();
    if (active || choosing) return;
    choosing = true;
    try {
      const [handle] = await globalThis.showOpenFilePicker({
        id: 'transmit-video',
        multiple: false,
        types: [
          {
            description: messages.encoding.videoFiles,
            accept: {
              'video/mp4': ['.mp4', '.m4v'],
              'video/webm': ['.webm'],
              'video/quicktime': ['.mov'],
              'video/x-matroska': ['.mkv'],
            },
          },
          { description: 'MPEG-TS', accept: { 'video/mp2t': ['.ts', '.m2ts', '.mts'] } },
        ],
      });
      if (!handle) return;
      const file = await handle.getFile();
      if (active) return;
      // Retain the native filename display and required-field validation.
      const transfer = new DataTransfer();
      transfer.items.add(file);
      videoInput.files = transfer.files;
      videoInput.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (error) {
      if (error.name !== 'AbortError')
        status.textContent = error.message || messages.encoding.openVideoFailed;
    } finally {
      choosing = false;
    }
  });
  $('transmit-cancel').addEventListener('click', () => {
    if (!active || cancelled || $('transmit-cancel').disabled) return;
    cancelled = true;
    $('transmit-cancel').disabled = true;
    status.textContent = messages.encoding.cancelling;
    if (worker) {
      worker.postMessage({ type: 'cancel' });
      // Give the worker time to abort its OPFS stream before forcing termination.
      abortTimer = setTimeout(() => {
        worker?.terminate();
        rejectGeneration?.(new DOMException(messages.encoding.cancelled, 'AbortError'));
      }, 2000);
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (active) return;
    const video = videoInput.files?.[0];
    if (!video) {
      status.textContent = messages.encoding.chooseVideo;
      return;
    }
    const settings = {
      format: $('transmit-format').value,
      sampleRate: $('transmit-rate').value,
      guard: $('transmit-guard').value,
      amplitude: $('transmit-amplitude').value,
      programName: $('transmit-program-name').value,
      description: $('transmit-description').value,
      stationName: $('transmit-station-name').value,
    };
    active = true;
    cancelled = false;
    controls();
    const chunks = [];
    let temporaryName;
    try {
      temporaryName = `1seg-convert-${crypto.randomUUID()}.ts`;
      status.textContent = messages.encoding.readingVideo;
      const result = await new Promise((resolve, reject) => {
        rejectGeneration = reject;
        worker = new Worker(new URL('./iq-generation-worker.js', import.meta.url), {
          type: 'module',
        });
        worker.onerror = (event) => reject(new Error(event.message || messages.encoding.failed));
        worker.onmessageerror = () => reject(new Error(messages.encoding.failed));
        worker.onmessage = async ({ data }) => {
          if (cancelled) {
            if (data.type === 'error' || data.type === 'complete')
              reject(new DOMException(messages.encoding.cancelled, 'AbortError'));
            return;
          }
          try {
            if (data.type === 'write') {
              chunks.push(data.bytes);
              if (!cancelled) worker?.postMessage({ type: 'written' });
            } else if (data.type === 'complete') resolve(data.result);
            else if (data.type === 'error') reject(new Error(data.text));
            else if (data.type === 'progress')
              status.textContent =
                data.phase === 'video'
                  ? messages.encoding.videoProgress(Math.floor(data.progress * 100))
                  : messages.encoding.iqProgress(
                      data.expectedSeconds
                        ? Math.min(99, Math.floor((data.seconds / data.expectedSeconds) * 100)) +
                            '% · '
                        : '',
                      data.seconds.toFixed(1),
                    );
          } catch (error) {
            reject(error);
          }
        };
        worker.postMessage({ type: 'generate', file: video, settings, name: temporaryName });
      });
      if (cancelled) throw new DOMException(messages.encoding.cancelled, 'AbortError');
      $('transmit-cancel').disabled = true;
      rejectGeneration = null;
      downloadBlob(
        new Blob(chunks, { type: 'application/octet-stream' }),
        video.name.replace(/\.[^.]+$/, '') + '.iq',
      );
      status.textContent = messages.encoding.complete(
        result.durationSeconds.toFixed(2),
        (result.bytes / 1048576).toFixed(1),
      );
    } catch (error) {
      status.textContent =
        cancelled || error.name === 'AbortError' ? messages.encoding.cancelled : error.message;
    } finally {
      clearTimeout(abortTimer);
      abortTimer = null;
      worker?.terminate();
      worker = null;
      rejectGeneration = null;
      chunks.length = 0;
      if (temporaryName) {
        try {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry(temporaryName);
        } catch (error) {
          if (error.name !== 'NotFoundError') {
            status.textContent += ` ${messages.encoding.cleanupFailed}`;
            globalThis.receiverUI?.showError(messages.encoding.cleanupFailed);
          }
        }
      }
      active = false;
      controls();
    }
  });
  controls();
}
