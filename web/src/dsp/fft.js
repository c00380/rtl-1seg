import { FFT as SignalsFFT } from '../../vendor/signals.js';

// Keep interleaved arrays and the receiver's FFT normalization at the boundary.
export class FFT {
  constructor(length) {
    this.fft = SignalsFFT.ofLength(length);
    this.length = this.fft.length;
    this.real = new Float32Array(this.length);
    this.imag = new Float32Array(this.length);
  }
  transform(output, input) {
    this.run(output, input, false);
  }
  inverseTransform(output, input) {
    this.run(output, input, true);
  }
  run(output, input, inverse) {
    const { length, real, imag } = this;
    for (let i = 0; i < length; i++) {
      real[i] = input[i * 2];
      imag[i] = input[i * 2 + 1];
    }
    const [outReal, outImag] = inverse
      ? this.fft.reverse(real, imag)
      : this.fft.transform(real, imag);
    const scale = inverse ? 1 / length : length;
    for (let i = 0; i < length; i++) {
      output[i * 2] = outReal[i] * scale;
      output[i * 2 + 1] = outImag[i] * scale;
    }
  }
}
