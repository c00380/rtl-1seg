import { messages } from '../messages.js';
import { workerRpc } from '../app/worker-rpc.js';

// This worker lives only for a completed recording and never shares the live decoder.
export async function convertRecording(blob, output, { timeout = 60000 } = {}) {
  const worker = new Worker(new URL('./recording-conversion-worker.js', import.meta.url), {
    type: 'module',
  });
  let timer, session;
  const watchProgress = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => session.dispose(new Error(messages.recording.conversionTimeout)),
      timeout,
    );
  };
  try {
    session = workerRpc(worker, { progress: watchProgress }, messages.recording.conversionFailed);
    watchProgress();
    const result = await session.call('convert', blob, output);
    if (!(result instanceof Blob) || !result.size)
      throw new Error(messages.recording.conversionFailed);
    return result;
  } finally {
    clearTimeout(timer);
    session?.dispose();
  }
}
