import { messages } from '../messages.js';
import { ReceptionSession } from './reception-session.js';
import { withTimeout } from './async-operation.js';
import { audioOutputTiming } from '../media/audio-clock.js';
import { ChannelRegistry, ScanReception, scanChannels } from './channel-registration.js';
import { ReceptionPolicy, hasStationIdentity } from './reception-policy.js';
import { Recording } from '../media/recording.js';
import { UsbWorkerReceiver } from '../sdr/receiver.js';
import { IqFileReceiver } from '../sdr/iq-file.js';
import { iqSettings } from '../dsp/iq-formats.js';
import { inputLevel } from '../dsp/input-level.js';
import { CHANNELS, GAINS } from './channels.js';
import { programTitle } from '../ui/program.js';
import { CaptionView } from '../ui/captions.js';
import { isRecordingProhibited } from '../ui/recording-policy.js';
import '../ui/receiver.js';
const $ = (id) => document.getElementById(id);
const DEFAULT_GAIN_DB = 32.8;
let browserStorage;
try {
  browserStorage = globalThis.localStorage;
} catch {
  /* Session-only registration remains available. */
}
const channelRegistry = new ChannelRegistry(browserStorage);
const usbReceiver = new UsbWorkerReceiver();
let iqFile = null;
const fileInput = () => $('input-source').value === 'file';
const receptionPolicy = new ReceptionPolicy(browserStorage);
let channelScan = null,
  scanProgress = null,
  scanProbe = null;
let policyStopPending = false;
const clockFormat = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
let broadcastTime = null;
function updateClock() {
  const elapsed = broadcastTime ? performance.now() - broadcastTime.at : Infinity;
  const value = elapsed >= 0 && elapsed < 120000 ? new Date(broadcastTime.epoch + elapsed) : null;
  globalThis.receiverUI?.setClock(value ? clockFormat.format(value) : '');
}
function setBroadcastTime(epoch = null) {
  broadcastTime = Number.isFinite(epoch) ? { epoch, at: performance.now() } : null;
  updateClock();
}
updateClock();
setInterval(updateClock, 1000);

const captions = new CaptionView($('captions'), $('caption-toggle'));
let information = null;
function showAudioTracks({
  tracks = [],
  selected = null,
  dualAvailable = false,
  dualSelected = 'main',
} = {}) {
  const select = $('audio');
  select.options.length = 0;
  for (const track of tracks) select.add(new Option(track.label, track.id));
  if (selected && tracks.some((track) => track.id === selected)) select.value = selected;
  select.disabled = session.busy || tracks.length < 2;
  const dual = $('audio-dual');
  dual.options.length = 0;
  if (dualAvailable) {
    for (const [id, label] of [
      ['main', messages.common.mainAudio],
      ['sub', messages.common.subAudio],
      ['both', messages.common.bothAudio],
    ])
      dual.add(new Option(label, id));
    dual.value = dualSelected;
  }
  dual.disabled = session.busy || !dualAvailable;
  globalThis.receiverUI?.syncMenus();
}
function showCaptionTracks({ present = false, supported = true } = {}) {
  captions.setAvailable(present && supported);
  globalThis.receiverUI?.syncMenus();
}
function showProgram(value) {
  if (!channelScan && !receptionPolicy.allows(value)) {
    void fail(new Error(messages.app.nhkDisabled));
    return;
  }
  information = value;
  scanProbe?.observeProgram(value);
  const now = Date.now();
  document.title = programTitle(value, now);
  globalThis.receiverUI?.setProgram(value, now);
}
setInterval(() => {
  if (information) showProgram(information);
}, 10000);
showProgram(null);

const screen = $('screen'),
  fullscreenButton = $('fullscreen');
function updateFullscreenButton() {
  const active = document.fullscreenElement === screen;
  fullscreenButton.textContent = active
    ? messages.common.exitFullscreen
    : messages.common.fullscreen;
  fullscreenButton.setAttribute('aria-pressed', String(active));
  fullscreenButton.setAttribute(
    'aria-label',
    active ? messages.app.exitTvFullscreen : messages.app.tvFullscreen,
  );
  globalThis.receiverUI?.setFullscreen(active);
}
fullscreenButton.onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await screen.requestFullscreen();
  } catch (error) {
    $('message').textContent = error.message || messages.app.fullscreenFailed;
    globalThis.receiverUI?.showError($('message').textContent);
  }
};
document.addEventListener('fullscreenchange', updateFullscreenButton);
for (const channel of CHANNELS)
  $('channel').add(
    new Option(
      messages.app.physicalChannelOption(channel.channel, (channel.hz / 1e6).toFixed(3)),
      channel.channel,
    ),
  );
for (const gain of GAINS) $('gain').add(new Option(`${gain.toFixed(1)} dB`, String(gain)));
$('gain').value = String(DEFAULT_GAIN_DB);

const entries = [];
function log(text) {
  entries.push(`${new Date().toLocaleTimeString()}  ${text}`);
  if (entries.length > 50) entries.shift();
  globalThis.receiverUI?.setLog(entries);
}
let lastLevel = 0;
function showLevel(iq) {
  const now = performance.now();
  if (now - lastLevel < 1000 / 30) return;
  lastLevel = now;
  const db = inputLevel(iq, 127.5, 128);
  if (db === null) return;
  scanProbe?.observeLevel(db);
  globalThis.receiverUI?.setLevel(db);
}
const session = new ReceptionSession({
  saveRecording: () => recording.stop(),
  usbReceiver,
  onChange: controls,
  onReset: () => {
    recordingBlocked = false;
    blank();
    showProgram(null);
  },
});
let recordingState = { active: false, saving: false, elapsed: 0 };
let lastRecordingControls = null;
let recordingBlocked = false;
const recordingSupported = Recording.supported();
const recording = new Recording({
  onState(state) {
    recordingState = state;
    recordingControls();
  },
  onError(message) {
    log(message);
    globalThis.receiverUI?.showError(message);
  },
  onSaved({ filename }) {
    log(messages.app.recordingSaved(filename));
  },
});
function canRecord() {
  return Boolean(
    session.device &&
      !session.busy &&
      session.transportReady &&
      !recordingBlocked &&
      (receptionPolicy.enabled || hasStationIdentity(information)) &&
      receptionPolicy.allows(information),
  );
}
function recordingControls() {
  const state = {
    ...recordingState,
    available: canRecord(),
    supported: recordingSupported,
    blocked: recordingBlocked,
  };
  if (
    lastRecordingControls &&
    Object.keys(state).every((key) => state[key] === lastRecordingControls[key])
  )
    return;
  lastRecordingControls = state;
  globalThis.receiverUI?.setRecording?.(state);
}
if (globalThis.receiverUI)
  globalThis.receiverUI.onRecord = async () => {
    if (recording.active) {
      await recording.stop();
      return;
    }
    if (!canRecord()) return;
    try {
      await recording.start({
        worker: session.demodWorker,
        format: $('recording-format')?.value || 'ts',
        name:
          [information?.stationName, information?.current?.title].filter(Boolean).join('_') ||
          messages.app.recordingChannelName($('channel').value),
      });
      log(messages.common.startRecording);
    } catch (error) {
      if (error.name !== 'AbortError') globalThis.receiverUI?.showError(error.message);
    } finally {
      recordingControls();
    }
  };
function controls() {
  $('usb').disabled = session.busy;
  $('channel').disabled = session.busy || fileInput();
  $('gain').disabled = session.busy || fileInput();
  $('input-source').disabled = session.busy || Boolean(session.device);
  for (const id of ['iq-open', 'iq-format', 'iq-sample-rate'])
    $(id).disabled = session.busy || Boolean(session.device);
  $('iq-file-settings').hidden = !fileInput();
  $('audio').disabled = session.busy || $('audio').options.length < 2;
  $('audio-dual').disabled = session.busy || $('audio-dual').options.length < 2;
  $('usb').textContent = session.device ? messages.common.stop : messages.common.start;
  globalThis.receiverUI?.setControls(Boolean(session.device), session.busy);
  recordingControls();
  channelControls();
  if (!session.busy && policyStopPending) {
    policyStopPending = false;
    void globalThis.receiverUI?.onNHKChange?.(false);
  }
}
function channelControls() {
  globalThis.receiverUI?.setNHKReception?.(receptionPolicy.enabled, session.busy);
  for (const option of $('channel').options)
    option.disabled = channelRegistry.entries.some(
      (value) => String(value.channel) === String(option.value) && !receptionPolicy.allows(value),
    );
  globalThis.receiverUI?.syncMenus();
  globalThis.receiverUI?.setChannels?.({
    entries: channelRegistry.entries.filter((value) => receptionPolicy.allows(value)),
    activeChannel: fileInput() ? null : Number($('channel').value),
    busy: session.busy,
    fileInput: fileInput(),
    scanning: Boolean(channelScan),
    progress: scanProgress,
  });
}
function blank() {
  globalThis.receiverUI?.setVideoCanvas?.(null);
  session.audioPlaying = false;
  globalThis.receiverUI?.setReceptionInformation?.(null);
  setBroadcastTime();
  showAudioTracks();
  showCaptionTracks();
  globalThis.receiverUI?.resetData?.();
  captions.clear();
  $('no-signal').hidden = false;
  session.lastFrame = 0;
  session.transportReady = false;
  globalThis.receiverUI?.setScope();
  globalThis.receiverUI?.setLevel();
  globalThis.receiverUI?.setSignalMonitor?.();
}
const stop = () => session.stop();
async function start(device) {
  const known = channelRegistry.entries.find(
    (value) => value.channel === Number($('channel').value),
  );
  if (device.kind !== 'file' && !channelScan && !receptionPolicy.allows(known))
    throw new Error(messages.app.nhkDisabled);
  session.device = device;
  $('message').textContent = '';
  session.audioContext = new AudioContext({ sampleRate: 48000 });
  await session.audioContext.audioWorklet.addModule(
    new URL('../media/pcm-worklet.js', import.meta.url),
  );
  session.pcmNode = new AudioWorkletNode(session.audioContext, 'pcm-player', {
    outputChannelCount: [2],
  });
  const pcmNode = session.pcmNode;
  pcmNode.onprocessorerror = () => {
    if (session.pcmNode !== pcmNode) return;
    void fail(new Error(messages.reception.workerStopped));
  };
  if (globalThis.receiverUI) {
    session.gainNode = session.audioContext.createGain();
    session.gainNode.gain.value = channelScan ? 0 : globalThis.receiverUI.volume();
    session.pcmNode.connect(session.gainNode);
    session.gainNode.connect(session.audioContext.destination);
  } else session.pcmNode.connect(session.audioContext.destination);
  await session.audioContext.resume();
  await session.device.open({
    channel: Number($('channel').value),
    gain: Number($('gain').value),
  });
  // A fresh canvas permits transferring ownership after reconnect or channel changes.
  const cv = document.createElement('canvas');
  cv.id = 'cv';
  cv.width = 320;
  cv.height = 180;
  $('cv').replaceWith(cv);
  const offscreenCanvas = cv.transferControlToOffscreen();
  session.generation = 0;
  const mediaWorker = new Worker(new URL('../media/worker.js', import.meta.url), {
    type: 'module',
  });
  session.mediaWorker = mediaWorker;
  const demodWorker = new Worker(new URL('../dsp/worker.js', import.meta.url), {
    type: 'module',
  });
  session.demodWorker = demodWorker;
  const transport = new MessageChannel();
  const playback = new MessageChannel();
  session.pcmNode.port.postMessage({ type: 'connect', port: playback.port1 }, [playback.port1]);
  const updateAudioTiming = () => {
    if (session.mediaWorker === mediaWorker)
      mediaWorker.postMessage({
        type: 'audio-output-timing',
        timing: audioOutputTiming(session.audioContext),
      });
  };
  session.audioContext.onstatechange = updateAudioTiming;
  session.timingTimer = setInterval(updateAudioTiming, 250);
  await withTimeout(
    () =>
      new Promise((resolve, reject) => {
        mediaWorker.onerror = (e) => {
          if (session.mediaWorker !== mediaWorker) return;
          const error = new Error(e.message || messages.app.decodeFailed);
          reject(error);
          recording.interrupt();
          if (scanProbe) scanProbe.fail(error);
          else if (!session.busy) fail(error);
        };
        mediaWorker.onmessage = ({ data: message }) => {
          if (session.mediaWorker !== mediaWorker) {
            return;
          }
          const isCurrentGeneration = message.generation === session.generation;
          if (message.type === 'ready') {
            resolve();
          } else if (message.type === 'error') {
            const error = new Error(message.text);
            reject(error);
            if (scanProbe) scanProbe.fail(error);
            else if (!session.busy) fail(error);
          } else if (message.type === 'recording-data' || message.type === 'recording-stopped') {
            recording.receive(message);
          } else if (message.type === 'transport-ready') {
            session.transportReady = Boolean(message.available);
            recordingControls();
          } else if (message.type === 'media-warning' && isCurrentGeneration) {
            log(message.text);
            globalThis.receiverUI?.showError(message.text);
          } else if (message.type === 'scope' && isCurrentGeneration)
            globalThis.receiverUI?.setScope(message.points);
          else if (message.type === 'signal-monitor' && isCurrentGeneration) {
            scanProbe?.observeSynchronization(message.information?.diagnostics?.symbols > 0);
            globalThis.receiverUI?.setSignalMonitor?.(message.information, {
              frequency:
                device.kind === 'file'
                  ? undefined
                  : CHANNELS.find((c) => c.channel === Number($('channel').value))?.hz,
              gain: device.kind === 'file' ? undefined : Number($('gain').value),
              format: device.kind === 'file' ? messages.app.floatIqFormat : undefined,
            });
          } else if (message.type === 'station-blocked' && isCurrentGeneration)
            void fail(new Error(messages.app.nhkDisabled));
          else if (message.type === 'program-information' && isCurrentGeneration)
            showProgram(message.information);
          else if (message.type === 'reception-information' && isCurrentGeneration) {
            recordingBlocked = isRecordingProhibited(message.information);
            if (recordingBlocked && recording.active && !recording.saving) {
              log(messages.common.recordingProhibited);
              globalThis.receiverUI?.showError(messages.common.recordingProhibited);
              void recording.stop();
            }
            recordingControls();
            globalThis.receiverUI?.setReceptionInformation?.(message.information, {
              channel: Number($('channel').value),
              frequency: CHANNELS.find((c) => c.channel === Number($('channel').value))?.hz,
            });
          } else if (message.type === 'broadcast-time' && isCurrentGeneration)
            setBroadcastTime(message.epoch);
          else if (message.type === 'audio-tracks' && isCurrentGeneration) showAudioTracks(message);
          else if (message.type === 'audio-state' && isCurrentGeneration)
            session.audioPlaying = Boolean(message.playing);
          else if (message.type === 'caption-tracks' && isCurrentGeneration)
            showCaptionTracks(message);
          else if (message.type === 'data-broadcasting' && isCurrentGeneration)
            globalThis.receiverUI?.receiveData?.(message.messages);
          else if (message.type === 'media-reset') {
            globalThis.receiverUI?.setVideoCanvas?.(null);
            session.generation = message.generation;
            recordingBlocked = false;
            recordingControls();
            if (message.recovery)
              log(messages.app.synchronizationRecovered(message.recovery.reason));
            scanProbe?.reset();
            setBroadcastTime();
            captions.clear();
            globalThis.receiverUI?.resetData?.();
            globalThis.receiverUI?.setReceptionInformation?.(null);
            globalThis.receiverUI?.setSignalMonitor?.();
            globalThis.receiverUI?.setScope();
            showProgram(null);
            session.audioPlaying = false;
          } else if (message.type === 'caption' && isCurrentGeneration) {
            captions.draw(message.tokens);
          } else if (message.type === 'frame' && isCurrentGeneration) {
            if (!channelScan) globalThis.receiverUI?.setVideoCanvas?.(cv);
            scanProbe?.observeFrame();
            session.lastFrame = performance.now();
            $('no-signal').hidden = true;
            recordingControls();
          }
        };
        demodWorker.onerror = mediaWorker.onerror;
        mediaWorker.onmessageerror = demodWorker.onmessageerror = mediaWorker.onerror;
        demodWorker.onmessage = mediaWorker.onmessage;
        mediaWorker.postMessage(
          {
            type: 'init',
            canvas: offscreenCanvas,
            scan: Boolean(channelScan),
            port: transport.port1,
            audioPort: playback.port2,
            sampleRate: session.audioContext.sampleRate,
            audioTiming: audioOutputTiming(session.audioContext),
          },
          [offscreenCanvas, transport.port1, playback.port2],
        );
        demodWorker.postMessage(
          {
            type: 'init',
            port: transport.port2,
            fileInput: device.kind === 'file',
            blockNHK: !receptionPolicy.enabled,
          },
          [transport.port2],
        );
      }),
    messages.app.decoderTimeout,
  );
  $('audio-dual').onchange = () => {
    if (session.mediaWorker === mediaWorker)
      mediaWorker.postMessage({
        type: 'audio-dual-selection',
        id: $('audio-dual').value,
        generation: session.generation,
      });
  };
  $('audio').onchange = () => {
    if (session.mediaWorker === mediaWorker)
      mediaWorker.postMessage({
        type: 'audio-selection',
        id: $('audio').value,
        generation: session.generation,
      });
  };
  log(
    device.kind === 'file'
      ? messages.app.iqPlaybackStarted(
          device.file.name,
          device.settings.format,
          device.settings.sampleRate,
        )
      : messages.app.receiverConnected($('channel').value, $('gain').value + ' dB'),
  );
  await session.device.connectDecoder(demodWorker);
  session.readTask = session.device.readSamples((iq) => {
    if (session.mediaWorker !== mediaWorker) return;
    if (Number.isFinite(iq?.level)) globalThis.receiverUI?.setLevel(iq.level);
    else showLevel(iq);
  });
  session.readTask.then(
    () => {
      if (device.kind === 'file' && device.ended && session.mediaWorker === mediaWorker)
        void finishFile(device, mediaWorker).catch(fail);
    },
    (e) => {
      if (session.mediaWorker === mediaWorker) {
        if (scanProbe) scanProbe.fail(e);
        else fail(e);
      }
    },
  );
}
async function finishFile(device, current) {
  const deadline = performance.now() + 3000;
  while (
    session.mediaWorker === current &&
    (session.busy || session.audioPlaying) &&
    performance.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  if (session.mediaWorker !== current || session.device !== device) return;
  return runOperation(async () => {
    const decoded = Boolean(session.lastFrame);
    await stop();
    $('iq-file-status').textContent = messages.app.playbackEnded(device.file.name);
    log(messages.app.iqPlaybackEnded);
    globalThis.receiverUI?.showNotice?.(
      decoded ? messages.app.iqPlaybackComplete : messages.app.iqPlaybackNoVideo,
    );
  });
}
async function fail(e) {
  return session.recover(e, (error, cleanupError) => {
    $('message').textContent = error.message || messages.app.startFailed;
    log(messages.app.error($('message').textContent));
    if (cleanupError) log(messages.app.cleanupFailed(cleanupError.message));
    globalThis.receiverUI?.showError($('message').textContent);
  });
}
function runOperation(operation) {
  return session.run(async () => {
    try {
      return await operation();
    } catch (error) {
      await fail(error);
    }
  });
}
$('usb').onclick = async () => {
  if (session.busy) return;
  return runOperation(async () => {
    if (session.device) {
      await stop();
      log(messages.app.disconnected);
    } else {
      if (!('VideoDecoder' in window)) throw new Error(messages.app.videoUnsupported);
      if (fileInput()) {
        if (!iqFile) throw new Error(messages.app.chooseIqFile);
        const settings = iqSettings({
          format: $('iq-format').value,
          sampleRate: $('iq-sample-rate').value,
        });
        const device = new IqFileReceiver(iqFile, settings, {
          onProgress: (progress) => {
            if (session.device === device)
              $('iq-file-status').textContent = messages.app.iqPlaybackProgress(
                iqFile.name,
                Math.floor((progress.bytes / progress.total) * 100),
                progress.seconds.toFixed(1),
              );
          },
        });
        await start(device);
      } else {
        await usbReceiver.select();
        await start(usbReceiver);
      }
    }
  });
};
async function retune() {
  channelControls();
  if (!session.device || session.busy || session.device.kind === 'file') return;
  const device = session.device;
  return runOperation(async () => {
    await stop();
    await start(device);
  });
}
$('channel').onchange = retune;
$('gain').onchange = retune;
$('input-source').onchange = () => {
  showProgram(information);
  controls();
};
$('iq-open').onclick = () => $('iq-file').click();
$('iq-file').onchange = () => {
  const file = $('iq-file').files?.[0];
  if (!file || session.device || session.busy) return;
  iqFile = file;
  $('iq-file-status').textContent = file.name;
  controls();
};
if (globalThis.receiverUI) {
  globalThis.receiverUI.onNHKChange = async (enabled) => {
    if (enabled) {
      channelControls();
      return;
    }
    try {
      receptionPolicy.disable();
    } catch (error) {
      channelControls();
      globalThis.receiverUI.showError(error.message);
      return;
    }
    channelControls();
    channelScan?.abort();
    if (session.busy && !channelScan) {
      policyStopPending = true;
      session.demodWorker?.postMessage({ type: 'block-nhk' });
      return;
    }
    if (session.device && !channelScan) {
      await runOperation(stop);
    }
    globalThis.receiverUI.showNotice?.(messages.app.nhkDisabledNotice);
  };
  globalThis.receiverUI.onRemoteChannel = async (remoteKey) => {
    if (session.busy || fileInput()) return;
    const selected = channelRegistry.find(remoteKey);
    if (!selected || !receptionPolicy.allows(selected)) return;
    if (session.device && Number($('channel').value) === selected.channel) return;
    $('channel').value = String(selected.channel);
    channelControls();
    if (session.device) await retune();
    else await $('usb').onclick();
  };
  globalThis.receiverUI.onRegisterChannels = async () => {
    if (fileInput()) return;
    if (channelScan) {
      channelScan.abort();
      return;
    }
    if (session.busy) return;
    const previous = {
      receiving: Boolean(session.device),
      channel: $('channel').value,
      gain: $('gain').value,
    };
    const controller = new AbortController();
    channelScan = controller;
    return session.run(async () => {
      log(messages.app.registrationStarted);
      try {
        await usbReceiver.select();
        await stop();
        $('gain').value = String(DEFAULT_GAIN_DB);
        const entries = await scanChannels({
          signal: controller.signal,
          onProgress: (progress) => {
            scanProgress = progress;
            channelControls();
          },
          probe: async (channel, signal) => {
            $('channel').value = String(channel);
            globalThis.receiverUI?.syncMenus();
            channelControls();
            const probe = new ScanReception(channel, {
                acceptInformation: (value) => receptionPolicy.allows(value),
              }),
              device = usbReceiver;
            scanProbe = probe;
            const abort = () => {
              device.close().catch(() => {});
            };
            signal.addEventListener('abort', abort, { once: true });
            try {
              await start(device);
              return await probe.wait(signal);
            } finally {
              signal.removeEventListener('abort', abort);
              scanProbe = null;
              await stop();
            }
          },
        });
        if (entries.length) {
          channelRegistry.save(entries.filter((value) => receptionPolicy.allows(value)));
          log(messages.app.registrationLog(entries.length));
          globalThis.receiverUI?.showNotice?.(messages.app.registrationComplete(entries.length));
        } else {
          log(messages.app.registrationEmpty);
          globalThis.receiverUI?.showNotice?.(messages.app.registrationNoStations);
        }
      } catch (error) {
        log(error.message);
        if (error.name === 'AbortError' || controller.signal.aborted)
          globalThis.receiverUI?.showNotice?.(messages.app.registrationCancelled);
        else globalThis.receiverUI?.showError(error.message);
      } finally {
        scanProbe = null;
        try {
          await stop();
        } catch (error) {
          log(messages.app.cleanupFailed(error.message));
        }
        $('channel').value = previous.channel;
        $('gain').value = previous.gain;
        channelScan = null;
        scanProgress = null;
        if (
          previous.receiving &&
          receptionPolicy.allows(
            channelRegistry.entries.find((value) => String(value.channel) === previous.channel),
          )
        ) {
          try {
            await start(usbReceiver);
          } catch (error) {
            await fail(error);
          }
        }
      }
    });
  };
}
setInterval(() => {
  if (session.lastFrame && performance.now() - session.lastFrame > 3000) {
    captions.clear();
    $('no-signal').hidden = false;
  }
  recordingControls();
}, 1000);
blank();

if (globalThis.receiverUI)
  globalThis.receiverUI.onVolume = (value) => {
    if (session.gainNode)
      session.gainNode.gain.setTargetAtTime(
        channelScan ? 0 : value,
        session.audioContext.currentTime,
        0.02,
      );
  };
controls();
