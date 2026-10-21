import { readTransportPacket, concatBytes } from './transport.js';
import { PESReader } from '../../vendor/arib-si.js';
import {
  ARIBB24JapaneseJIS8Tokenizer,
  ARIBB24Parser,
  ARIBB24JapaneseInitialParserState,
  demuxDatagroup,
  captionCRC,
} from '../../vendor/arib-caption.js';
import { pesTimestamp } from '../media/formats.js';
// STD-B24 profile C (one-seg): G0=DRCS-1, G1=ASCII, G2=Kanji, G3=Macro.
// The library defaults to profile A; designate C's initial sets explicitly.
const C_SETS = Uint8Array.of(
  0x1b,
  0x28,
  0x20,
  0x41,
  0x1b,
  0x29,
  0x4a,
  0x1b,
  0x24,
  0x2a,
  0x42,
  0x1b,
  0x2b,
  0x20,
  0x70,
  0x0f,
  0x1b,
  0x7d,
);
const C_STATE = {
  ...ARIBB24JapaneseInitialParserState,
  plane: [320, 180],
  area: [320, 180],
  fontsize: [18, 18],
  hspace: 2,
  vspace: 6,
  position: [0, 23],
};
export { captionCRC };

class CaptionTokenizer extends ARIBB24JapaneseJIS8Tokenizer {
  // aribb24.js 2.0.26 rounds bitmap lengths down. Read ceil(bits/8), with
  // bounds checks, so a non-byte-aligned DRCS glyph cannot corrupt the next.
  processDRCS(bytes, data) {
    if ((bytes !== 1 && bytes !== 2) || !data.length) throw new RangeError('DRCS');
    const pending = [];
    let p = 1;
    const take = (n) => {
      if (p + n > data.length) throw new RangeError('DRCS');
      const a = data.subarray(p, p + n);
      p += n;
      return a;
    };
    for (let c = 0; c < data[0]; c++) {
      const [hi, lo, fonts] = take(3);
      for (let f = 0; f < fonts; f++) {
        const mode = take(1)[0] & 15;
        if (mode > 1) throw new RangeError('DRCS mode');
        const [depth, width, height] = take(3),
          bits = Math.ceil(Math.log2(depth + 2));
        const binary = take(Math.ceil((width * height * bits) / 8)).slice().buffer;
        const entry = Object.values(this.drcs_dicts).find(
          (d) => d.type === 'DRCS' && d.code === (bytes === 1 ? hi : 0x40),
        );
        if (!width || !height) throw new RangeError('DRCS size');
        if (entry)
          pending.push({
            entry,
            key: bytes === 1 ? lo & 127 : ((hi & 127) << 8) | (lo & 127),
            glyph: { width, height, depth: bits, binary },
          });
      }
    }
    // A damaged definition must not replace a glyph downloaded earlier.
    for (const { entry, key, glyph } of pending) entry.dict.set(key, glyph);
  }
}

// Bounded TS/PES assembly, independent of the video/audio elementary streams.
export class Captions {
  constructor(clock, emit, onState = () => {}) {
    this.clock = clock;
    this.emit = emit;
    this.onState = onState;
    this.pid = null;
    this.reset();
  }
  notifyState() {
    this.onState({ supported: this.management === null || this.selectedLanguage !== null });
  }
  reset() {
    this.pesReader = new PESReader();
    this.received = 0;
    this.cc = null;
    this.links = null;
    this.management = null;
    this.selectedLanguage = null;
    this.tokenizer = new CaptionTokenizer();
    this.queue = [];
    this.emit([]);
    this.notifyState();
  }
  push(packet, pid) {
    if (pid !== this.pid) {
      this.pid = pid;
      this.reset();
    }
    if (
      pid === null ||
      packet.length !== 188 ||
      packet[0] !== 0x47 ||
      (((packet[1] & 31) << 8) | packet[2]) !== pid
    )
      return;
    const afc = (packet[3] >> 4) & 3,
      cc = packet[3] & 15;
    const drop = () => {
      this.pesReader.reset();
      this.received = 0;
      this.links = null;
    };
    if (packet[1] & 128 || packet[3] & 192 || !afc) {
      drop();
      this.cc = null;
      return;
    }
    if (afc & 2 && packet[4] > 0 && packet[5] & 128) {
      drop();
      this.cc = null;
    }
    if (!(afc & 1) || cc === this.cc) return;
    if (this.cc !== null && cc !== ((this.cc + 1) & 15)) drop();
    this.cc = cc;
    const off = 4 + (afc & 2 ? 1 + packet[4] : 0);
    if (off >= 188) {
      drop();
      return;
    }
    if (packet[1] & 64) {
      this.received = 0;
      // Subtitle PES must have a bounded, nonzero length and private_stream_1.
      if (off + 6 >= 188 || packet[off + 3] !== 0xbd || !(packet[off + 4] || packet[off + 5])) {
        drop();
        return;
      }
    }
    this.received += 188 - off;
    if (this.received > 65719) {
      drop();
      return;
    }
    const parsed = readTransportPacket(packet);
    if (!parsed) {
      drop();
      return;
    }
    for (const pes of this.pesReader.pushPacket(parsed)) {
      if (pes[3] !== 0xbd || (pes[4] === 0 && pes[5] === 0)) continue;
      this.received = 0;
      try {
        this.pes(pes);
      } catch {
        this.links = null;
      }
    }
  }
  pes(pes) {
    const raw = pesTimestamp(pes, 0),
      off = 9 + pes[8];
    if (off + 3 > pes.length || pes[off] !== 0x80 || pes[off + 1] !== 0xff) return;
    const pts = raw === null ? null : this.clock.unwrap(raw);
    let p = off + 3 + (pes[off + 2] & 15);
    while (p + 7 <= pes.length) {
      const size = (pes[p + 3] << 8) | pes[p + 4],
        end = p + size + 7;
      if (end > pes.length) return;
      const data = pes.subarray(p, end);
      p = end;
      if (captionCRC(data) !== 0) {
        this.links = null;
        continue;
      }
      const id = data[0],
        link = data[1],
        last = data[2];
      if (link > last) {
        this.links = null;
        continue;
      }
      if (link === 0) this.links = { id, last, next: 0, pts, body: new Uint8Array() };
      const chain = this.links;
      if (!chain || chain.id !== id || chain.last !== last || chain.next !== link) {
        this.links = null;
        continue;
      }
      chain.body = concatBytes([chain.body, data.subarray(5, -2)]);
      chain.next++;
      if (chain.body.length > 65535) {
        this.links = null;
        continue;
      }
      if (link !== last) continue;
      this.links = null;
      const complete = concatBytes([
        Uint8Array.of(id, 0, 0, chain.body.length >> 8, chain.body.length & 255),
        chain.body,
      ]);
      this.group(demuxDatagroup(concatBytes([complete, Uint8Array.of(0, 0)])), chain.pts);
    }
  }
  group(data, pts) {
    if (!data) return;
    if (data.tag === 'CaptionManagement') {
      // A/B switches replace language and DRCS definitions; repetitions don't
      // clear the subtitle currently on screen.
      const groupChanged = this.management?.group !== data.group,
        previousLanguage = this.selectedLanguage;
      if (groupChanged) {
        this.tokenizer = new CaptionTokenizer();
        this.queue = [];
        this.selectedLanguage = null;
        this.emit([]);
      }
      this.management = data;
      const supported = data.languages.filter(
        (language) => language.TCS === 0 && language.iso_639_language_code === 'jpn',
      );
      if (!supported.some((language) => language.lang === this.selectedLanguage))
        this.selectedLanguage = supported[0]?.lang ?? null;
      if (!groupChanged && previousLanguage !== this.selectedLanguage) {
        this.tokenizer = new CaptionTokenizer();
        this.queue = [];
        this.emit([]);
      }
      this.tokenizer.tokenize(data);
      this.notifyState();
      return;
    }
    const language = this.management?.languages.find((item) => item.lang === this.selectedLanguage);
    if (
      !language ||
      data.group !== this.management.group ||
      data.lang !== language.lang ||
      language.TCS !== 0 ||
      pts === null
    )
      return;
    // Reinitialize control/graphic state per statement; retain downloaded DRCS.
    this.tokenizer.tokenizeStatement(C_SETS);
    const tokens = this.tokenizer.tokenize(data);
    const parser = new ARIBB24Parser(C_STATE, { magnification: 1 });
    const batches = [];
    let elapsed = 0,
      current = [];
    const flush = () => {
      if (current.length) {
        batches.push({ pts: pts + elapsed * 1e6, tokens: current });
        current = [];
      }
    };
    for (const token of tokens) {
      if (
        Object.values(token).some(
          (v) => typeof v === 'number' && (!Number.isFinite(v) || Math.abs(v) > 4096),
        )
      )
        return;
      // Reject zero-sized drawing areas/cells before the parser's wrapping
      // loops. Malformed broadcast controls must never stall reception.
      if (token.tag === 'SetDisplayFormat' && (!(token.horizontal > 0) || !(token.vertical > 0)))
        return;
      if (
        token.tag === 'CharacterCompositionDotDesignation' &&
        (!(token.horizontal > 0) || !(token.vertical > 0))
      )
        return;
      if (token.tag === 'TimeControlWait') {
        flush();
        elapsed += token.seconds;
        if (elapsed > 3600) return;
        continue;
      }
      // Delayed clear is already scheduled by this queue, not the renderer.
      current.push(...parser.parseToken(token));
      if (current.length > 4096) return;
    }
    flush();
    this.queue.push(...batches);
    this.queue.sort((a, b) => a.pts - b.pts);
    if (this.queue.length > 128) {
      this.queue = [];
      this.emit([]);
    }
  }
  render(time) {
    let tokens = [];
    while (this.queue.length && this.queue[0].pts <= time) {
      const cue = this.queue.shift();
      tokens.push(...cue.tokens);
    }
    if (tokens.length) this.emit(tokens);
  }
}
