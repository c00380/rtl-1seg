import { SectionReader, calculateCRC32 } from '../../vendor/arib-si.js';

// The caller owns the reserved trailing CRC bytes and each returned TS packet.
export function writeSectionCRC(section) {
  new DataView(section.buffer, section.byteOffset, section.byteLength).setUint32(
    section.length - 4,
    calculateCRC32(section.subarray(0, -4), -1),
  );
  return section;
}

export function nullPacket() {
  const packet = new Uint8Array(188).fill(255);
  packet.set([0x47, 0x1f, 0xff, 0x10]);
  return packet;
}

export function* packetizeSection(pid, section, counters = new Map()) {
  for (let offset = 0; offset < section.length; ) {
    const first = offset === 0,
      packet = new Uint8Array(188).fill(255),
      cc = counters.get(pid) ?? 0,
      begin = first ? 5 : 4;
    packet.set([0x47, (pid >> 8) | (first ? 0x40 : 0), pid & 255, 0x10 | cc]);
    counters.set(pid, (cc + 1) & 15);
    if (first) packet[4] = 0;
    const count = Math.min(188 - begin, section.length - offset);
    packet.set(section.subarray(offset, offset + count), begin);
    offset += count;
    yield packet;
  }
}
// The decoder supplies aligned 188-byte packets. Header validation stays here;
// PSI pointer fields, fragments and section assembly belong to the library.
export function readTransportPacket(data) {
  if (data.length !== 188 || data[0] !== 0x47) return null;
  const adaptationFieldControl = (data[3] >> 4) & 3;
  const payloadOffset = 4 + (adaptationFieldControl & 2 ? 1 + data[4] : 0);
  if (!adaptationFieldControl || payloadOffset > 188) return null;
  return {
    data,
    payloadOffset,
    adaptationFieldControl,
    transportErrorIndicator: !!(data[1] & 128),
    transportScramblingControl: data[3] >> 6,
    payloadUnitStartIndicator: !!(data[1] & 64),
    transportPriority: !!(data[1] & 32),
    pid: ((data[1] & 31) << 8) | data[2],
    continuityCounter: data[3] & 15,
    discontinuity: !!(adaptationFieldControl & 2 && data[4] > 0 && data[5] & 128),
  };
}

class RawSections extends SectionReader {
  constructor(onSection) {
    super(undefined);
    this.onSection = onSection;
  }
  pushSection(pid, bytes) {
    // The library's normal dispatcher omits TDT and CAT events. Keep all raw
    // sections available, then readSection handles typed SI and CRC checks.
    if (bytes.length <= 4096) this.onSection(bytes, pid);
  }
}

export class SectionPackets {
  constructor(onSection) {
    this.onSection = onSection;
    this.states = new Map();
  }
  reset() {
    this.states.clear();
  }
  push(data) {
    const pid = ((data[1] & 31) << 8) | data[2];
    const packet = readTransportPacket(data);
    if (!packet || packet.transportErrorIndicator || packet.transportScramblingControl) {
      this.states.delete(pid);
      return;
    }
    if (packet.discontinuity) this.states.delete(pid);
    if (!(packet.adaptationFieldControl & 1)) return;
    if (
      packet.payloadOffset >= 188 ||
      (packet.payloadUnitStartIndicator &&
        packet.payloadOffset + 1 + data[packet.payloadOffset] > 188)
    ) {
      this.states.delete(pid);
      return;
    }
    let state = this.states.get(pid);
    if (state?.cc === packet.continuityCounter) return;
    if (state && ((state.cc + 1) & 15) !== packet.continuityCounter) {
      this.states.delete(pid);
      state = null;
    }
    if (!state) {
      if (!packet.payloadUnitStartIndicator) return;
      state = { reader: new RawSections(this.onSection), cc: null };
      this.states.set(pid, state);
    }
    state.cc = packet.continuityCounter;
    try {
      state.reader.push(packet);
    } catch {
      this.states.delete(pid);
    }
  }
}

// Copy byte fragments without expanding them into boxed JavaScript numbers.
export function concatBytes(parts) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
