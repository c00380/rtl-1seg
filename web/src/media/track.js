import {
  Input,
  MPEG_TS,
  ReadableStreamSource,
  EncodedPacketSink,
  VideoSampleSink,
  AudioSampleSink,
} from '../../vendor/mediabunny.js';
import { readTransportPacket, writeSectionCRC, packetizeSection } from '../broadcast/transport.js';
const MAX_QUEUED_BYTES = 512 * 1024;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_PES_BYTES = 2_000_000;

// Derive a one-track PMT from the CRC-validated, selected broadcast service.
// Separate inputs keep audio selection independent of video decoder lifetime.
function selectedPMT(kind, { program, pid, pcr }) {
  const section = Uint8Array.of(
    2,
    0xb0,
    18,
    program >> 8,
    program & 255,
    0xc1,
    0,
    0,
    0xe0 | ((pcr ?? pid) >> 8),
    (pcr ?? pid) & 255,
    0xf0,
    0,
    kind === 'video' ? 0x1b : 0x0f,
    0xe0 | (pid >> 8),
    pid & 255,
    0xf0,
    0,
    0,
    0,
    0,
    0,
  );
  return packetizeSection(0x1fc8, writeSectionCRC(section)).next().value;
}

export class MediabunnyTrack {
  constructor(
    kind,
    {
      onPacket = () => {},
      onSample = () => {},
      onReset = () => {},
      onError = () => {},
      decode,
    } = {},
  ) {
    this.kind = kind;
    this.callbacks = { onPacket, onSample, onReset, onError };
    this.decode =
      decode ??
      typeof (kind === 'video' ? globalThis.VideoDecoder : globalThis.AudioDecoder) === 'function';
    this.state = null;
    this.cc = null;
    this.received = 0;
    this.finished = Promise.resolve();
    this.restarts = 0;
  }
  reset() {
    const state = this.state;
    this.state = null;
    this.cc = null;
    this.received = 0;
    if (state) {
      state.input.dispose();
      this.callbacks.onReset();
    }
  }
  close() {
    this.reset();
  }
  start(selection) {
    this.reset();
    const state = { selection, controller: null, input: null };
    const stream = new ReadableStream(
      {
        start: (controller) => {
          state.controller = controller;
        },
      },
      { highWaterMark: MAX_QUEUED_BYTES, size: (bytes) => bytes.byteLength },
    );
    const source = new ReadableStreamSource(stream, {
      maxCacheSize: MAX_CACHE_BYTES,
      handleUnhandledError: (error) => this.fail(state, error),
    });
    state.input = new Input({ formats: [MPEG_TS], source });
    this.state = state;
    state.controller.enqueue(selectedPMT(this.kind, selection));
    this.finished = this.run(state).catch((error) => this.fail(state, error));
  }
  fail(state, error) {
    if (this.state !== state) return;
    this.restarts++;
    this.reset();
    this.callbacks.onError(error);
  }
  push(bytes, selection) {
    const packet = readTransportPacket(bytes);
    if (
      !packet ||
      packet.pid !== selection.pid ||
      packet.transportErrorIndicator ||
      packet.transportScramblingControl
    ) {
      this.reset();
      return;
    }
    const current = this.state?.selection;
    if (
      current &&
      (current.pid !== selection.pid ||
        current.program !== selection.program ||
        current.pcr !== selection.pcr)
    )
      this.reset();
    if (packet.discontinuity) this.reset();
    if (!(packet.adaptationFieldControl & 1)) return;
    if (this.cc === packet.continuityCounter) return;
    if (this.cc !== null && ((this.cc + 1) & 15) !== packet.continuityCounter) this.reset();
    if (packet.payloadOffset >= 188) {
      this.reset();
      return;
    }
    if (!this.state) {
      if (!packet.payloadUnitStartIndicator) return;
      this.start(selection);
    }
    this.cc = packet.continuityCounter;
    if (packet.payloadUnitStartIndicator) this.received = 0;
    this.received += 188 - packet.payloadOffset;
    const state = this.state;
    if (this.received > MAX_PES_BYTES || state.controller.desiredSize < bytes.length) {
      this.fail(state, new Error('Media input backlog or PES exceeded the receiver limit'));
      return;
    }
    // Decoder output buffers can be reused upstream; the live source owns this copy.
    state.controller.enqueue(bytes.slice());
  }
  end() {
    this.state?.controller.close();
    return this.finished;
  }
  async run(state) {
    const track =
      this.kind === 'video'
        ? await state.input.getPrimaryVideoTrack()
        : await state.input.getPrimaryAudioTrack();
    if (this.state !== state) return;
    if (!track || track.id !== state.selection.pid)
      throw new Error('Selected MPEG-TS media track was not found');
    const packets = new EncodedPacketSink(track);
    let first = await packets.getFirstPacket();
    // ADTS configuration 0 needs a PCE before Chrome can begin decoding. Keep
    // searching through live packets; diagnostics tell us when one is present.
    while (first && this.state === state) {
      const ready = this.callbacks.onPacket(first, state.selection.pid);
      if (this.kind !== 'audio' || ready !== false) break;
      first = await packets.getNextPacket(first);
    }
    if (!first || this.state !== state) return;
    const observe = async () => {
      let initial = true;
      for await (const packet of packets.packets(first)) {
        if (this.state !== state) break;
        if (initial) {
          initial = false;
          continue;
        }
        this.callbacks.onPacket(packet, state.selection.pid);
      }
    };
    const decode = async () => {
      if (!this.decode) return;
      const sink =
        this.kind === 'video'
          ? new VideoSampleSink(track, { optimizeForLatency: true })
          : new AudioSampleSink(track);
      for await (const sample of sink.samples(first.timestamp)) {
        try {
          if (this.state === state) this.callbacks.onSample(sample, state.selection.pid);
        } finally {
          sample.close();
        }
      }
    };
    // Disposing the input cancels pending reads and both decoder/observer tasks.
    await Promise.all([observe(), decode()]);
  }
}
