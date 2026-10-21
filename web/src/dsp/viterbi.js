import { createViterbi } from '../../vendor/viterbi.js';

// libfec owns path selection; the adapter preserves continuous, tail-free input.
// Returned streaming bits are a view valid until the next call, never transferred.
export class Viterbi {
  constructor(depth = 96) {
    if (!Number.isInteger(depth) || depth < 1) throw new RangeError('Invalid Viterbi depth');
    this.depth = depth;
    this.api = createViterbi();
    this.inputCapacity = 0;
    this.historyCapacity = 0;
    this.reserve(512, depth);
    this.api.init(depth);
  }
  reserve(count, history) {
    if (count <= this.inputCapacity && history <= this.historyCapacity) return;
    this.inputCapacity = Math.max(count, this.inputCapacity);
    this.historyCapacity = Math.max(history, this.historyCapacity);
    const historyOffset = this.api.__heap_base.value;
    const inputOffset = historyOffset + this.historyCapacity * 8;
    const outputOffset = inputOffset + this.inputCapacity * 8;
    const bytes = outputOffset + this.inputCapacity;
    const memory = this.api.memory;
    if (bytes > memory.buffer.byteLength)
      memory.grow(Math.ceil((bytes - memory.buffer.byteLength) / 65536));
    this.input = new Float32Array(memory.buffer, inputOffset, this.inputCapacity * 2);
    this.output = new Uint8Array(memory.buffer, outputOffset, this.inputCapacity);
    this.api.configure(historyOffset, inputOffset, outputOffset);
  }
  push(coded) {
    if (coded.length % 2) throw new RangeError('Incomplete Viterbi soft pair');
    this.reserve(coded.length / 2, this.depth);
    this.input.set(coded);
    return this.output.subarray(0, this.api.push(coded.length / 2));
  }
  decode(coded) {
    if (coded.length % 2) throw new RangeError('Incomplete Viterbi soft pair');
    const count = coded.length / 2;
    this.reserve(count, Math.max(count, this.depth));
    this.input.set(coded);
    this.api.decode(count);
    return this.output.slice(0, count);
  }
  free() {
    this.api = this.input = this.output = null;
  }
}
