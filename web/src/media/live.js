import { MediabunnyTrack } from './track.js';
import { BroadcastClock, aacProgramConfig } from './formats.js';
import { ProgramMap } from '../broadcast/program-map.js';
import { ProgramInformation } from '../broadcast/program-information.js';
import { ReceptionInformation } from '../broadcast/reception-information.js';
import { Captions } from '../broadcast/captions.js';
import { DataBroadcasting } from '../data/broadcasting.js';
import { ServiceProbe } from '../broadcast/service-probe.js';
import { isNHK, hasStationIdentity } from '../app/reception-policy.js';
import { messages } from '../messages.js';
// Display follows the audio output clock; bound stale clocks and queued frames.
const RENDER_INTERVAL_MS = 10;
const MAX_VIDEO_QUEUE_FRAMES = 60;
const MAX_AUDIO_CLOCK_AGE_MS = 250;
const AUDIO_CLOCK_LOOKAHEAD_MS = 100;
const VIDEO_EARLY_TOLERANCE_US = 15000;
const MAX_VIDEO_LATENESS_US = 500000;

// TS payloads → H.264/AAC frames → WebCodecs → audio-clock-driven display.
export class LiveMedia {
  constructor(canvas, { post, generation, scanMode = false, blockNHK = false }) {
    this.post = post;
    this.generation = generation;
    this.scanMode = scanMode;
    this.serviceProbe = scanMode || blockNHK ? new ServiceProbe() : null;
    this.probeState = '';
    this.blockedPosted = false;
    this.programMap = new ProgramMap(() => {
      this.syncAudio();
      this.syncCaption();
    });
    this.data = new DataBroadcasting((messages) =>
      this.post({ type: 'data-broadcasting', messages, generation: this.generation() }),
    );
    this.reception = new ReceptionInformation();
    this.programInformation = new ProgramInformation(
      (epoch) => this.post({ type: 'broadcast-time', epoch, generation: this.generation() }),
      (section, pid) => this.reception.read(section, pid),
      this.programMap,
    );
    this.programInformationState = '';
    this.clock = new BroadcastClock();
    this.captionInfo = { supported: true };
    this.captionOptionsState = '';
    this.captions = new Captions(
      this.clock,
      (tokens) => this.post({ type: 'caption', tokens, generation: this.generation() }),
      (info) => {
        this.captionInfo = info;
        this.syncCaption();
      },
    );
    this.videoFrames = [];
    this.audioClock = null;
    this.videoClock = null;
    this.closed = false;
    this.mediaFailures = new Map();
    this.renderTimer = setInterval(() => this.render(), RENDER_INTERVAL_MS);
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.videoMedia = new MediabunnyTrack('video', {
      onPacket: (packet) => this.inspectVideoPacket(packet.data),
      onSample: (sample) => this.acceptVideoSample(sample),
      onReset: () => {
        this.videoClock = null;
        for (const frame of this.videoFrames) frame.close();
        this.videoFrames = [];
      },
      onError: (error) => this.reportMediaFailure('video', error),
    });
    this.audioMedia = new MediabunnyTrack('audio', {
      onPacket: (packet) => this.inspectAudioPacket(packet.data),
      onSample: (sample) => this.acceptAudioSample(sample),
      onReset: () => {
        if (!this.closed) this.post({ type: 'audio-reset', generation: this.generation() });
      },
      onError: (error) => this.reportMediaFailure('audio', error),
    });
    this.audioRoute = null;
    this.audioOptionsState = '';
  }
  reportMediaFailure(kind, error) {
    console.warn(`Mediabunny ${kind} recovery:`, error);
    if (this.closed) return;
    const now = performance.now();
    let failures = this.mediaFailures.get(kind);
    if (!failures || now - failures.since > 30000) {
      failures = { since: now, count: 0 };
      this.mediaFailures.set(kind, failures);
    }
    if (++failures.count !== 3) return;
    this.post({
      type: 'media-warning',
      text: messages.reception.mediaRecoveryFailed,
      generation: this.generation(),
    });
  }
  syncAudio() {
    const options = this.programMap.audioOptions(),
      selected = this.programMap.selectedAudioTrack();
    const state = {
      tracks: options.map(({ id, label }) => ({ id, label })),
      selected: selected?.id ?? null,
      dualAvailable: this.programMap.dualAudio,
      dualSelected: this.programMap.dualSelection,
    };
    const serialized = JSON.stringify(state);
    if (serialized !== this.audioOptionsState) {
      this.audioOptionsState = serialized;
      this.post({ type: 'audio-tracks', ...state, generation: this.generation() });
    }
    const route = selected?.pid ?? null;
    if (route !== this.audioRoute) this.videoClock = null;
    if (this.audioRoute !== null && route !== this.audioRoute) this.resetAudio(true);
    this.audioRoute = route;
  }
  syncReception() {
    const information = this.reception.snapshot(this.programMap, this.captions);
    if (information !== undefined)
      this.post({ type: 'reception-information', information, generation: this.generation() });
  }
  setAudioSelection(id) {
    if (this.programMap.selectAudio(id)) {
      this.syncAudio();
      this.syncReception();
    }
  }
  setDualAudioSelection(id) {
    if (this.programMap.selectDualAudio(id)) {
      this.post({ type: 'audio-reset', generation: this.generation() });
      this.syncAudio();
    }
  }
  syncCaption() {
    const state = {
      known: this.programMap.program !== null,
      present: this.programMap.caption !== null,
      ...this.captionInfo,
    };
    const serialized = JSON.stringify(state);
    if (serialized !== this.captionOptionsState) {
      this.captionOptionsState = serialized;
      this.post({ type: 'caption-tracks', ...state, generation: this.generation() });
    }
  }
  resetAudio(notify = false) {
    const hadInput = this.audioMedia.state !== null;
    this.audioMedia.reset();
    if (notify && !hadInput) this.post({ type: 'audio-reset', generation: this.generation() });
  }
  pushTs(ts) {
    if (this.closed) return;
    if (this.serviceProbe) {
      const information = this.serviceProbe.push(ts);
      if (this.scanMode) {
        const state = JSON.stringify(information);
        if (state !== this.probeState) {
          this.probeState = state;
          this.post({ type: 'program-information', information, generation: this.generation() });
        }
        return;
      }
      // Hold all media, captions and data until the tuned service is identified.
      if (!hasStationIdentity(information) || isNHK(information)) {
        if (isNHK(information) && !this.blockedPosted) {
          this.blockedPosted = true;
          this.post({ type: 'station-blocked', information, generation: this.generation() });
        }
        return;
      }
    }
    for (let i = 0; i + 188 <= ts.length; i += 188) {
      const packet = ts.subarray(i, i + 188),
        pid = ((packet[1] & 31) << 8) | packet[2];
      const previousVideo = this.programMap.video;
      this.programInformation.pushPacket(packet);
      if (previousVideo !== this.programMap.video) this.resetVideo();
      this.captions.push(packet, this.programMap.caption);
      const selection = { program: this.programMap.program, pid, pcr: this.programMap.pcr };
      if (pid === this.programMap.video) this.videoMedia.push(packet, selection);
      else if (pid === this.programMap.audio) this.audioMedia.push(packet, selection);
    }
    this.data.push(ts, this.programMap.program);
    const information = this.programInformation.snapshot(this.programMap.program);
    const serialized = JSON.stringify(information);
    if (serialized !== this.programInformationState) {
      this.programInformationState = serialized;
      this.post({ type: 'program-information', information, generation: this.generation() });
    }
    this.syncReception();
  }
  inspectVideoPacket(data) {
    // Diagnostic SPS parsing stays separate from Mediabunny's frame extraction.
    for (let i = 0; i + 3 < data.length; i++) {
      if (data[i] || data[i + 1] || data[i + 2] !== 1 || (data[i + 3] & 31) !== 7) continue;
      let end = i + 4;
      while (
        end + 2 < data.length &&
        !(data[end] === 0 && data[end + 1] === 0 && data[end + 2] === 1)
      )
        end++;
      this.reception.videoHeader(
        data.subarray(i + 3, end + 2 >= data.length ? data.length : end),
        this.programMap.video,
      );
    }
  }
  inspectAudioPacket(adts) {
    this.reception.audioHeader(adts, this.programMap.audio);
    const channelConfig = ((adts[2] & 1) << 2) | ((adts[3] >> 6) & 3);
    const pce = channelConfig === 0 ? aacProgramConfig(adts) : { dual: false };
    if (pce) {
      this.programMap.setAudioConfig(this.programMap.audio, {
        dual: pce.dual,
        type: pce.dual ? 2 : channelConfig === 1 ? 1 : channelConfig === 6 ? 9 : 3,
      });
    }
    return channelConfig !== 0 || pce !== null;
  }
  sampleTimestamp(sample) {
    const wrap = 2 ** 33;
    const raw = ((Math.round(sample.timestamp * 90000) % wrap) + wrap) % wrap;
    return this.clock.unwrap(raw);
  }
  acceptAudioSample(sample) {
    if (this.closed) return;
    this.reception.audioOutput(sample, this.programMap.audio);
    this.syncReception();
    const channels = [],
      selectedChannel = this.programMap.mainAudioChannel;
    for (let index = 0; index < (selectedChannel === null ? sample.numberOfChannels : 1); index++) {
      const samples = new Float32Array(sample.numberOfFrames);
      sample.copyTo(samples, {
        planeIndex: Math.min(selectedChannel ?? index, sample.numberOfChannels - 1),
        format: 'f32-planar',
      });
      channels.push(samples);
    }
    this.post(
      {
        type: 'pcm',
        sr: sample.sampleRate,
        chs: channels,
        pts: this.sampleTimestamp(sample),
        generation: this.generation(),
      },
      channels.map((x) => x.buffer),
    );
  }
  acceptVideoSample(sample) {
    if (this.closed) return;
    sample.setTimestamp(this.sampleTimestamp(sample) / 1e6);
    const frame = sample.toVideoFrame();
    this.reception.videoOutput(frame, this.programMap.video);
    this.syncReception();
    this.videoFrames.push(frame);
    this.videoFrames.sort((a, b) => a.timestamp - b.timestamp);
    while (this.videoFrames.length > MAX_VIDEO_QUEUE_FRAMES) this.videoFrames.shift().close();
    this.render();
  }
  render() {
    const now = performance.now();
    let target;
    if (this.programMap.program !== null && this.programMap.audio === null) {
      // A confirmed video-only service has no audio output clock to follow.
      if (!this.videoClock && this.videoFrames.length)
        this.videoClock = { pts: this.videoFrames[0].timestamp, at: now };
      if (!this.videoClock) return;
      target = this.videoClock.pts + (now - this.videoClock.at) * 1000;
    } else {
      // Audio services follow actual output and wait when that clock is stale.
      if (!this.audioClock || now - this.audioClock.at > MAX_AUDIO_CLOCK_AGE_MS) return;
      target =
        this.audioClock.pts + Math.min(AUDIO_CLOCK_LOOKAHEAD_MS, now - this.audioClock.at) * 1000;
    }
    this.captions.render(target);
    let frame = null;
    while (
      this.videoFrames.length &&
      this.videoFrames[0].timestamp <= target + VIDEO_EARLY_TOLERANCE_US
    ) {
      if (frame) frame.close();
      frame = this.videoFrames.shift();
    }
    if (!frame) return;
    if (target - frame.timestamp < MAX_VIDEO_LATENESS_US) {
      if (this.canvas.width !== frame.displayWidth) this.canvas.width = frame.displayWidth;
      if (this.canvas.height !== frame.displayHeight) this.canvas.height = frame.displayHeight;
      this.context.drawImage(frame, 0, 0);
      this.post({ type: 'frame', generation: this.generation() });
    }
    frame.close();
  }
  async drainVideo() {
    if (this.programMap.audio !== null) return;
    while (!this.closed && this.videoFrames.length)
      await new Promise((resolve) => setTimeout(resolve, RENDER_INTERVAL_MS));
  }
  close() {
    this.closed = true;
    clearInterval(this.renderTimer);
    this.data.close();
    for (const frame of this.videoFrames) frame.close();
    this.videoFrames = [];
    this.captions.reset();
    this.resetVideo();
    this.resetAudio();
  }
  resetVideo() {
    this.videoClock = null;
    this.videoMedia.reset();
  }
}
