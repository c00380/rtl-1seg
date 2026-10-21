import { convertVideo } from './video-conversion.js';
import { encoderSettings, encodeTransportStream } from './iq-encoding.js';

let controller, written;
self.onmessage = async ({ data }) => {
  if (data.type === 'written') {
    written?.();
    written = null;
    return;
  }
  if (data.type === 'cancel') {
    controller?.abort();
    written?.();
    written = null;
    return;
  }
  if (data.type !== 'generate') return;
  controller = new AbortController();
  let stream;
  try {
    const settings = encoderSettings(data.settings);
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(data.name, { create: true });
    stream = await handle.createWritable();
    const converted = await convertVideo(data.file, stream, {
      guard: settings.guard,
      signal: controller.signal,
      onProgress: (progress) => self.postMessage({ type: 'progress', phase: 'video', progress }),
    });
    controller.signal.throwIfAborted();
    const file = await handle.getFile();
    const result = await encodeTransportStream(
      file.stream(),
      (bytes) =>
        new Promise((resolve) => {
          // One chunk in flight: wait until the selected file accepts it.
          written = resolve;
          self.postMessage({ type: 'write', bytes }, [bytes.buffer]);
        }),
      {
        ...settings,
        duration: converted.duration,
        mediabunnyTransport: true,
        signal: controller.signal,
        onProgress: (progress) => self.postMessage({ type: 'progress', ...progress }),
      },
    );
    controller.signal.throwIfAborted();
    self.postMessage({ type: 'complete', result });
  } catch (error) {
    await stream?.abort().catch(() => {});
    self.postMessage({ type: 'error', text: error.message });
  }
};
