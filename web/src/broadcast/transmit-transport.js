import { messages } from '../messages.js';
import { calculateCRC32 } from '../../vendor/arib-si.js';
import { readTransportPacket, writeSectionCRC, packetizeSection, nullPacket } from './transport.js';
import { pesTimestamp } from '../media/formats.js';

// Adapt Mediabunny's sparse single-program TS to the receiver's fixed-rate one-seg input.
// No AV encoding here: only PSI/PCR repetition, PMT relocation and null-packet scheduling.
export class TransmitTransport {
  constructor(bitrate) {
    this.rate = bitrate / (188 * 8);
    this.position = 0;
    this.tables = new Map();
    this.counters = new Map();
    this.videoPid = null;
    this.lastTime = null;
  }
  *idle() {
    const period = Math.max(4, Math.floor(this.rate / 10));
    if (this.position % period === 0 && this.tables.size === 2) {
      for (const [pid, section] of this.tables) {
        yield* packetizeSection(pid, section, this.counters);
        this.position++;
      }
    }
    if (this.videoPid !== null && this.position % Math.max(1, Math.floor(this.rate / 30)) === 0) {
      const out = new Uint8Array(188).fill(255);
      const cc = this.counters.get(this.videoPid) ?? 0;
      out.set([0x47, this.videoPid >> 8, this.videoPid & 255, 0x20 | cc, 183, 0x10]);
      const clock = Math.round((this.position / this.rate) * 27000000);
      const base = Math.floor(clock / 300),
        ext = clock % 300;
      out.set(
        [
          Math.floor(base / 2 ** 25),
          Math.floor(base / 2 ** 17) & 255,
          Math.floor(base / 512) & 255,
          Math.floor(base / 2) & 255,
          ((base & 1) << 7) | 0x7e | (ext >> 8),
          ext & 255,
        ],
        6,
      );
      yield out;
      this.position++;
    } else {
      yield nullPacket();
      this.position++;
    }
  }
  *push(bytes) {
    const header = readTransportPacket(bytes);
    if (!header || header.transportErrorIndicator || header.transportScramblingControl)
      throw new Error(messages.encoding.invalidPacket);
    const { pid, payloadOffset: offset } = header;
    if (pid === 0 || pid === 0x1000) {
      if (!header.payloadUnitStartIndicator) throw new Error(messages.encoding.multipartProgram);
      const begin = offset + 1 + bytes[offset];
      const length = 3 + (((bytes[begin + 1] & 15) << 8) | bytes[begin + 2]);
      const section = bytes.slice(begin, begin + length);
      if (section.length !== length || length > 183 || calculateCRC32(section, -1) !== 0)
        throw new Error(messages.encoding.invalidProgram);
      if (pid === 0) {
        section[10] = 0xff;
        section[11] = 0xc8;
      } else {
        let p = 12 + (((section[10] & 15) << 8) | section[11]);
        let videos = 0,
          audios = 0;
        while (p + 5 <= section.length - 4) {
          if (section[p] === 0x1b) {
            this.videoPid = ((section[p + 1] & 31) << 8) | section[p + 2];
            videos++;
          } else if (section[p] === 0x0f) audios++;
          else throw new Error(messages.encoding.unsupportedCodecs);
          p += 5 + (((section[p + 3] & 15) << 8) | section[p + 4]);
        }
        if (videos !== 1 || audios > 1) throw new Error(messages.encoding.wrongTrackCount);
        section[8] = 0xe0 | (this.videoPid >> 8);
        section[9] = this.videoPid & 255;
      }
      writeSectionCRC(section);
      const target = pid === 0 ? 0 : 0x1fc8;
      this.tables.set(target, section);
      yield* packetizeSection(target, section, this.counters);
      this.position++;
      return;
    }
    if (this.tables.size !== 2) throw new Error(messages.encoding.missingProgram);
    if (header.payloadUnitStartIndicator) {
      if (bytes[offset] !== 0 || bytes[offset + 1] !== 0 || bytes[offset + 2] !== 1)
        throw new Error(messages.encoding.invalidPes);
      const pts = pesTimestamp(bytes.subarray(offset), 0);
      if (pts === null || !Number.isFinite(pts) || pts < 0)
        throw new Error(messages.encoding.invalidTime);
      const time = pts / 90000;
      if (this.lastTime !== null && time + 0.1 < this.lastTime)
        throw new Error(messages.encoding.invalidTime);
      this.lastTime = Math.max(time, this.lastTime ?? 0);
      const due = Math.max(0, Math.floor((time - 0.7) * this.rate));
      while (this.position < due) yield* this.idle();
      if (this.position / this.rate > time + 0.1)
        throw new Error(messages.encoding.capacityExceeded);
    }
    const out = bytes.slice();
    // Preserve source payload CCs; adaptation-only PCR packets use the preceding CC.
    this.counters.set(pid, out[3] & 15);
    yield out;
    this.position++;
  }
  *end() {
    if (this.lastTime === null) throw new Error(messages.encoding.noMedia);
    const end = Math.ceil((this.lastTime + 0.1) * this.rate);
    while (this.position < end) yield* this.idle();
  }
}
