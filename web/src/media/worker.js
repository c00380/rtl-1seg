import { messages } from '../messages.js';
import { LiveMedia } from './live.js';
import { receiveAudioClock } from './audio-clock.js';
import { resampleChannels } from './formats.js';
import { withTimeout } from '../app/async-operation.js';

// Own TS parsing, AV decoding, captions and video rendering together.
function post(message, transfers = []) {
  if (message.type === 'pcm') {
    audioReceived = true;
    const chs = resampleChannels(message.chs, message.sr, outputSampleRate);
    audioPort.postMessage(
      { ...message, chs, sr: outputSampleRate },
      chs.map((ch) => ch.buffer),
    );
  } else if (message.type === 'audio-reset') {
    resetAudio();
  } else self.postMessage(message, transfers);
}
let media = null,
  generation = 0,
  canvas = null,
  scanMode = false;
let audioPort = null,
  outputSampleRate = 48000,
  outputTiming = null,
  audioPlaying = false;
let ready = false;
let audioReceived = false,
  audioEnd = null;
function setAudioPlaying(playing) {
  if (audioPlaying === playing) return;
  audioPlaying = playing;
  post({ type: 'audio-state', playing, generation });
}
function resetAudio() {
  audioEnd?.reject(new Error(messages.reception.workerStopped));
  audioEnd = null;
  audioReceived = false;
  if (media) media.audioClock = null;
  audioPort?.postMessage({ type: 'reset', generation });
  setAudioPlaying(false);
}

async function drainAudio() {
  if (!audioReceived || !audioPort) return;
  try {
    await withTimeout(
      () =>
        new Promise((resolve, reject) => {
          audioEnd = { resolve, reject };
          audioPort.postMessage({ type: 'end', generation });
        }),
      messages.reception.responseTimeout,
    );
    setAudioPlaying(false);
  } finally {
    audioEnd = null;
  }
}

async function receiveTransport(message, port) {
  try {
    if (message.type === 'reset') {
      media?.close();
      generation = message.generation;
      resetAudio();
      post({ type: 'media-reset', generation, recovery: message.recovery });
      media = new LiveMedia(canvas, {
        post,
        generation: () => generation,
        scanMode,
        blockNHK: Boolean(message.blockNHK),
      });
      if (!ready) {
        ready = true;
        post({ type: 'ready' });
      }
    } else if (media && message.generation === generation) {
      if (message.type === 'ts') media.pushTs(new Uint8Array(message.buf));
      else if (message.type === 'monitor') {
        media.reception.setPhysical(message.physical);
        media.syncReception();
        post({ type: 'scope', points: message.points, generation }, [message.points.buffer]);
        post({ type: 'signal-monitor', information: message.information, generation });
      } else if (message.type === 'end') {
        await Promise.all([media.audioMedia.end(), media.videoMedia.end()]);
        await drainAudio();
        await media.drainVideo();
      }
    }
    port.postMessage({ type: 'ack' });
  } catch {
    port.postMessage({ type: 'error', text: messages.reception.workerStopped });
  }
}
self.onmessage = ({ data: message }) => {
  try {
    if (message.type === 'init') {
      canvas = message.canvas;
      scanMode = Boolean(message.scan);
      audioPort = message.audioPort;
      outputSampleRate = message.sampleRate;
      outputTiming = message.audioTiming;
      if (audioPort) {
        audioPort.onmessage = ({ data }) => {
          if (data.type === 'audio-ended' && data.generation === generation && audioEnd) {
            // The last quantum is rendered ahead of the physical output device.
            // Wait for that same device-output clock before acknowledging EOF.
            const now = performance.timeOrigin + performance.now();
            const outputNow =
              outputTiming && outputTiming.running
                ? outputTiming.contextTime +
                  (now - outputTiming.sentAt) / 1000 -
                  outputTiming.latency
                : data.contextTime;
            const end = audioEnd;
            setTimeout(
              () => {
                if (audioEnd === end) end.resolve();
              },
              Math.max(0, (data.contextTime - outputNow) * 1000),
            );
            return;
          }
          if (data.type !== 'audio-clock' || !media || data.generation !== generation) return;
          media.audioClock = receiveAudioClock(data, performance.now(), outputTiming);
          setAudioPlaying(Boolean(media.audioClock));
        };
      }
      const port = message.port;
      port.onmessage = ({ data }) => receiveTransport(data, port);
    } else if (message.type === 'audio-output-timing') {
      outputTiming = message.timing;
      if (!outputTiming.running) {
        if (media) media.audioClock = null;
        setAudioPlaying(false);
      }
    } else if (media && message.generation === generation) {
      if (message.type === 'audio-dual-selection') media.setDualAudioSelection(message.id);
      else if (message.type === 'audio-selection') media.setAudioSelection(message.id);
    }
  } catch {
    post({ type: 'error', text: messages.reception.workerStopped });
  }
};
