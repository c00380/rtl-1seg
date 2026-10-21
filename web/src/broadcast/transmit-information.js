import { messages } from '../messages.js';
import { writeSectionCRC, packetizeSection, nullPacket } from './transport.js';
import { siKanji } from '../../vendor/arib-si-text.js';

// Encode the JIS X 0208 repertoire used by ARIB SI. Unsupported characters
// fail explicitly rather than silently changing the user's programme text.
export function encodeSIText(value) {
  const bytes = [];
  let mode = '';
  for (const character of value) {
    const code = character.codePointAt(0);
    if (character === '\n') {
      bytes.push(0x0d);
      continue;
    }
    if (code >= 0x20 && code <= 0x7e) {
      if (mode !== 'ascii') {
        bytes.push(0x0e, 0x89);
        mode = 'ascii';
      }
      bytes.push(code);
    } else {
      const pair = siKanji.get(character);
      if (!pair) throw new Error(messages.encoding.unsupportedCharacter(character));
      if (mode !== 'jis') {
        bytes.push(0x0f, 0x8a);
        mode = 'jis';
      }
      bytes.push(...pair);
    }
  }
  return bytes;
}
function descriptor(tag, body) {
  if (body.length > 255) throw new Error(messages.encoding.informationTooLong);
  return [tag, body.length, ...body];
}
function section(table, id, body, number = 0, last = 0) {
  const bytes = Uint8Array.from([
    table,
    0xf0,
    0,
    id >> 8,
    id & 255,
    0xc1,
    number,
    last,
    ...body,
    0,
    0,
    0,
    0,
  ]);
  const length = bytes.length - 3;
  if (length > 1021) throw new Error(messages.encoding.informationTooLong);
  bytes[1] |= length >> 8;
  bytes[2] = length & 255;
  return writeSectionCRC(bytes);
}
function takeText(characters, limit) {
  let text = '';
  while (characters.length && encodeSIText(text + characters[0]).length <= limit)
    text += characters.shift();
  return encodeSIText(text);
}
export function informationSections({ programName = '', description = '', stationName = '' } = {}) {
  const name = encodeSIText(programName),
    station = encodeSIText(stationName || 'IQ Video');
  if (name.length > 120 || station.length > 240) throw new Error(messages.encoding.namesTooLong);
  const service = descriptor(0x48, [0xc0, 0, station.length, ...station]);
  const result = [
    {
      pid: 0x11,
      bytes: section(0x42, 1, [
        0,
        1,
        255,
        0,
        1,
        3,
        0x80 | (service.length >> 8),
        service.length & 255,
        ...service,
      ]),
    },
  ];
  if (programName || description) {
    const remaining = [...description],
      summary = takeText(remaining, 250 - name.length);
    const descriptors = descriptor(0x4d, [
      0x6a,
      0x70,
      0x6e,
      name.length,
      ...name,
      summary.length,
      ...summary,
    ]);
    const chunks = [];
    while (remaining.length) chunks.push(takeText(remaining, 249));
    for (let i = 0; i < chunks.length; i++)
      descriptors.push(
        ...descriptor(0x4e, [
          (i << 4) | (chunks.length - 1),
          0x6a,
          0x70,
          0x6e,
          0,
          chunks[i].length,
          ...chunks[i],
        ]),
      );
    // Present event has unspecified start/duration; no invented schedule.
    const event = [
      0,
      1,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      0x80 | (descriptors.length >> 8),
      descriptors.length & 255,
      ...descriptors,
    ];
    result.push({ pid: 0x27, bytes: section(0x4e, 1, [0, 1, 0, 1, 1, 0x4e, ...event], 0, 1) });
    result.push({ pid: 0x27, bytes: section(0x4e, 1, [0, 1, 0, 1, 1, 0x4e], 1, 1) });
  }
  return result;
}
export class TransmitInformation {
  constructor(settings, bitrate) {
    this.sections = informationSections(settings);
    this.interval = Math.max(1, Math.floor(bitrate / (188 * 8) / 2));
    this.position = 0;
    this.queue = [];
    this.counters = new Map();
  }
  repeat() {
    // An IDR/PES burst can temporarily use all slots. Keep one bounded cycle
    // pending rather than dropping AV or treating a short burst as failure.
    if (this.queue.length) return;
    this.scheduled = this.position;
    for (const { pid, bytes } of this.sections) {
      this.queue.push(...packetizeSection(pid, bytes, this.counters));
    }
  }
  push(packet) {
    if (this.queue.length && this.position - this.scheduled > this.interval * 8)
      throw new Error(messages.encoding.insufficientPackets);
    if (this.position++ % this.interval === 0) this.repeat();
    const pid = ((packet[1] & 31) << 8) | packet[2];
    if (![0x1fff, 0x11, 0x12, 0x27].includes(pid)) return packet;
    return this.queue.shift() ?? nullPacket();
  }
}
