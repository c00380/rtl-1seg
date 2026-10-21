import { createReedSolomon } from '../../vendor/ezpwd.js';

function workspace() {
  const api = createReedSolomon();
  return { api, work: new Uint8Array(api.memory.buffer, api.rs_work(), 204) };
}

// EZPWD owns RS(204,188) arithmetic. Instances have isolated, fixed 64 KiB memory.
// Returned storage belongs to this instance, valid until the next decode call.
export class ReedSolomon {
  constructor() {
    const { api, work } = workspace();
    this.api = api;
    this.work = work;
    this.output = new Uint8Array(204);
  }
  isCodeword(block) {
    if (block.length !== 204) return false;
    this.work.set(block);
    return Boolean(this.api.rs_check());
  }
  decode(block) {
    if (block.length !== 204) return null;
    this.work.set(block);
    if (this.api.rs_decode() < 0) return null;
    this.output.set(this.work);
    return this.output;
  }
}

let encoder = null;
export function encodeRs(packet, output = new Uint8Array(204)) {
  if (packet.length !== 188 || packet[0] !== 0x47)
    throw new Error('Expected a 188-byte MPEG-TS packet');
  if (output.length < 204) throw new RangeError('Expected space for a 204-byte RS codeword');
  encoder ??= workspace();
  encoder.work.set(packet);
  encoder.api.rs_encode();
  output.fill(0);
  output.set(encoder.work);
  return output;
}
