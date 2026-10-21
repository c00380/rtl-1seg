import { messages } from '../messages.js';
import { TransmitTransport } from '../broadcast/transmit-transport.js';
import { informationSections, TransmitInformation } from '../broadcast/transmit-information.js';
import {
  OneSegModulator,
  IqResampler,
  SAMPLE_RATE,
  SYMBOLS_PER_FRAME,
  transportBitrate,
  NULL_PACKET,
  packIq,
} from '../dsp/modulator.js';

const TS_PACKET_BYTES = 188;
const PACKETS_PER_GROUP = 64;
const GROUP_BYTES = TS_PACKET_BYTES * PACKETS_PER_GROUP;

function number(value, name, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}
export function encoderSettings(values = {}) {
  if (!['s8', 's16', 'f32'].includes(values.format ?? 's8'))
    throw new Error(messages.encoding.chooseFormat);
  const settings = {
    format: values.format ?? 's8',
    sampleRate: number(values.sampleRate ?? 2000000, messages.common.sampleRate, 800000, 20000000),
    guard: number(values.guard ?? 8, messages.common.guard, 4, 32),
    amplitude: number(values.amplitude ?? 0.1, messages.common.amplitude, 0.0001, 1),
    programName: String(values.programName ?? '').trim(),
    description: String(values.description ?? '')
      .replace(/\r\n?/g, '\n')
      .trim(),
    stationName: String(values.stationName ?? '').trim(),
  };
  if (
    settings.programName.length > 120 ||
    settings.description.length > 500 ||
    settings.stationName.length > 120
  )
    throw new Error(messages.encoding.informationTooLong);
  if (settings.programName || settings.description || settings.stationName)
    informationSections(settings);
  return settings;
}
export async function encodeTransportStream(input, write, options = {}) {
  const { guard = 8, amplitude = 0.1, sampleRate = 2000000, format = 's8', signal } = options;
  const size = { s8: 1, s16: 2, f32: 4 }[format];
  if (!size) throw new Error('Unknown IQ format');
  if (!Number.isFinite(sampleRate) || sampleRate < 800000 || sampleRate > 20000000)
    throw new Error('Sample rate must be 800000..20000000 Hz');
  const mod = new OneSegModulator({ guard, amplitude }),
    resampler = await IqResampler.create(SAMPLE_RATE, sampleRate);
  try {
    const information =
      options.programName || options.description || options.stationName
        ? new TransmitInformation(options, transportBitrate(guard))
        : null;
    const nullPacket = () => (information ? information.push(NULL_PACKET) : NULL_PACKET);
    let inputPackets = 0,
      samples = 0;
    const queue = [];
    let queuedBytes = 0;
    const abort = () => {
      if (signal?.aborted) throw new Error('Encoding cancelled');
    };
    async function flush() {
      if (!queuedBytes) return;
      const bytes = new Uint8Array(queuedBytes);
      let offset = 0;
      for (const chunk of queue) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      queue.length = 0;
      queuedBytes = 0;
      await write(bytes);
      abort();
    }
    async function emit(iq) {
      if (!iq.length) return;
      samples += iq.length / 2;
      const bytes = packIq(iq, format);
      queue.push(bytes);
      queuedBytes += bytes.length;
      if (queuedBytes >= 1024 * 1024) await flush();
    }
    async function frame(nextPacket) {
      abort();
      for (let symbol = 0; symbol < SYMBOLS_PER_FRAME; symbol++)
        await emit(resampler.push(mod.nextSymbol(nextPacket)));
      // Yield every frame for cancellation and progress without unbounded buffering.
      await flush();
      options.onProgress?.({
        phase: 'iq',
        expectedSeconds: options.duration
          ? options.duration + 0.8 + (16 * SYMBOLS_PER_FRAME * (1024 + 1024 / guard)) / SAMPLE_RATE
          : null,
        inputPackets,
        samples,
        seconds: samples / sampleRate,
      });
    }

    for (let i = 0; i < 8; i++) await frame(nullPacket);
    // Each OFDM frame consumes one complete TS group. Reuse its storage instead
    // of copying the growing prefix for every 188-byte packet from the adapter.
    const group = new Uint8Array(GROUP_BYTES);
    let pendingBytes = 0;
    const adapter = options.mediabunnyTransport
      ? new TransmitTransport(transportBitrate(guard))
      : null;
    async function encodeGroup(bytes) {
      let position = 0;
      await frame(() => {
        if (position >= bytes.length) return nullPacket();
        let packet = bytes.subarray(position, position + TS_PACKET_BYTES);
        position += TS_PACKET_BYTES;
        if (packet[0] !== 0x47) throw new Error(`Invalid TS sync at packet ${inputPackets}`);
        if (information) packet = information.push(packet);
        inputPackets++;
        return packet;
      });
    }
    async function consume(bytes) {
      let offset = 0;
      while (offset < bytes.length) {
        const length = Math.min(GROUP_BYTES - pendingBytes, bytes.length - offset);
        group.set(bytes.subarray(offset, offset + length), pendingBytes);
        pendingBytes += length;
        offset += length;
        if (pendingBytes === GROUP_BYTES) {
          await encodeGroup(group);
          pendingBytes = 0;
        }
      }
    }
    let fragment = new Uint8Array();
    for await (const chunk of input) {
      abort();
      if (!adapter) await consume(chunk);
      else {
        if (fragment.length) {
          const joined = new Uint8Array(fragment.length + chunk.length);
          joined.set(fragment);
          joined.set(chunk, fragment.length);
          fragment = joined;
        } else fragment = chunk;
        while (fragment.length >= TS_PACKET_BYTES) {
          for (const packet of adapter.push(fragment.subarray(0, TS_PACKET_BYTES)))
            await consume(packet);
          fragment = fragment.subarray(TS_PACKET_BYTES);
        }
      }
    }
    if (fragment.length) throw new Error('TS ends with an incomplete 188-byte packet');
    if (adapter) for (const packet of adapter.end()) await consume(packet);
    if (pendingBytes % TS_PACKET_BYTES)
      throw new Error('TS ends with an incomplete 188-byte packet');
    if (pendingBytes) await encodeGroup(group.subarray(0, pendingBytes));
    if (!inputPackets) throw new Error('TS input is empty');
    // Flush byte/bit/time interleaving and give the receiver a complete final frame.
    for (let i = 0; i < 8; i++) await frame(nullPacket);
    await emit(resampler.push(new Float32Array(), true));
    await flush();
    return {
      bytes: samples * 2 * size,
      durationSeconds: samples / sampleRate,
      inputPackets,
    };
  } finally {
    resampler.close();
  }
}
