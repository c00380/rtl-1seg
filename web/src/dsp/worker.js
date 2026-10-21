import { messages } from '../messages.js';
import { readPhysicalInformation } from './physical-information.js';
import { SignalMonitor, readSignalDiagnostics } from './signal-monitor.js';
import { StreamingDecoder } from './decoder.js';
import { TransportRecording } from '../media/recording-stream.js';
import { withTimeout } from '../app/async-operation.js';

// IQ → TS only. AV decoding and rendering live in the media worker.
const MONITOR_INTERVAL_MS = 1000 / 30;
const post = (message, transfers = []) => self.postMessage(message, transfers);
const recording = new TransportRecording(post);
let decoder = null,
  mediaPort = null,
  mediaReply = null;
let generation = 0,
  locked = false,
  lastTs = Date.now(),
  lastScope = 0;
let signalMonitor = new SignalMonitor();
let fileMode = false,
  blockNHK = false;

// Only one exchange is outstanding. Waiting for TS consumption bounds the
// downstream queue and keeps resets and EOF behind all preceding transport data.
function sendMedia(message, transfers = []) {
  let reply;
  return withTimeout(
    () =>
      new Promise((resolve, reject) => {
        mediaReply = reply = { resolve, reject };
        mediaPort.postMessage({ ...message, generation }, transfers);
      }),
    messages.reception.responseTimeout,
  )
    .catch((error) => {
      // A late acknowledgement must not acknowledge a later TS/reset command.
      mediaPort?.close();
      mediaPort = null;
      throw error;
    })
    .finally(() => {
      if (mediaReply === reply) mediaReply = null;
    });
}
async function start(keepDecoder = false, recovery = null) {
  if (decoder && !keepDecoder) decoder.free();
  if (!keepDecoder) decoder = new StreamingDecoder();
  generation++;
  locked = false;
  post({ type: 'transport-ready', available: false });
  signalMonitor = new SignalMonitor();
  lastScope = 0;
  await sendMedia({ type: 'reset', recovery, blockNHK });
}
async function pumpLoop() {
  while (decoder && decoder.backlog() > 0) {
    const ts = decoder.pump();
    if (ts.length) {
      if (!locked) post({ type: 'transport-ready', available: true });
      locked = true;
      lastTs = Date.now();
      recording.push(ts);
      await sendMedia({ type: 'ts', buf: ts.buffer }, [ts.buffer]);
    }
    const recovery = decoder.takeRecovery?.();
    if (recovery) await start(true, recovery);
  }
}

// Message events do not await async handlers. All input and reset commands
// share this queue so later samples cannot overtake pumping or acknowledgements.
let iqTask = Promise.resolve();
function enqueue(message, reply = post) {
  iqTask = iqTask.then(() => handleMessage(message, reply));
  return iqTask;
}
self.onmessage = ({ data: message }) => {
  if (message.type === 'recording-start') {
    recording.start(message.id);
    return;
  }
  if (message.type === 'recording-stop') {
    recording.stop(message.id);
    return;
  }
  if (message.type === 'iq-port') {
    const port = message.port;
    port.onmessage = ({ data }) => {
      if (data.type === 'iq' || data.type === 'iq-end')
        enqueue(data, (reply) => port.postMessage(reply));
    };
    return;
  }
  return enqueue(message);
};
async function handleMessage(message, reply) {
  try {
    if (message.type === 'init') {
      mediaPort = message.port;
      mediaPort.onmessage = ({ data }) => {
        const pending = mediaReply;
        mediaReply = null;
        if (data.type === 'error') pending?.reject(new Error(data.text));
        else pending?.resolve();
      };
      fileMode = Boolean(message.fileInput);
      blockNHK = Boolean(message.blockNHK);
      await start();
    } else if (message.type === 'block-nhk') {
      blockNHK = true;
      await start();
    } else if (message.type === 'iq-end' && decoder) {
      await pumpLoop();
      await sendMedia({ type: 'end' });
      reply({ type: 'ended' });
    } else if (message.type === 'iq' && decoder) {
      if (
        message.gap ||
        (!fileMode && locked && Date.now() - lastTs > 5000) ||
        decoder.backlog() > 8192
      ) {
        await start();
        lastTs = Date.now();
      }
      const iq =
        message.format === 'f32' ? new Float32Array(message.buf) : new Uint8Array(message.buf);
      if (message.format === 'f32') {
        signalMonitor.pushFloat(iq);
        decoder.pushFloat(iq);
      } else {
        signalMonitor.push(iq);
        decoder.push(iq);
      }
      await pumpLoop();
      if (performance.now() - lastScope >= MONITOR_INTERVAL_MS) {
        lastScope = performance.now();
        const points = decoder.constellation();
        await sendMedia(
          {
            type: 'monitor',
            points,
            physical: readPhysicalInformation(decoder.physical_information()),
            information: {
              input: signalMonitor.snapshot(),
              diagnostics: readSignalDiagnostics(decoder.signal_monitor()),
            },
          },
          [points.buffer],
        );
      }
      reply({ type: 'ack', bytes: message.buf.byteLength });
    }
  } catch {
    post({ type: 'error', text: messages.reception.workerStopped });
  }
}
