import { parseAvcSps } from '../../vendor/mediabunny.js';

// PES timestamps stay on one 90 kHz timeline, including the 33-bit wrap.
export class BroadcastClock {
  unwrap(raw) {
    const wrap = 2 ** 33;
    if (this.last !== undefined) raw += Math.round((this.last - raw) / wrap) * wrap;
    this.last = raw;
    return (raw * 1e6) / 90000;
  }
}
export function pesTimestamp(p, off) {
  if (off + 14 > p.length || !(p[off + 7] & 0x80) || p[off + 8] < 5) return null;
  const b = p.subarray(off + 9, off + 14);
  if (!(b[0] & 1) || !(b[2] & 1) || !(b[4] & 1)) return null;
  return (
    ((b[0] >> 1) & 7) * 2 ** 30 + b[1] * 2 ** 22 + (b[2] >> 1) * 2 ** 15 + b[3] * 128 + (b[4] >> 1)
  );
}
export const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

// A dual-mono AAC program declares two front SCEs, unlike stereo's one CPE.
// Only inspect a leading PCE; never search arbitrary compressed spectral bits.
export function aacProgramConfig(adts) {
  let bit = (adts[1] & 1 ? 7 : 9) * 8;
  const read = (n) => {
    if (bit + n > adts.length * 8) throw new RangeError('Truncated PCE');
    let v = 0;
    while (n--) {
      v = v * 2 + ((adts[bit >> 3] >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return v;
  };
  try {
    if (read(3) !== 5) return null;
    read(4);
    read(2);
    read(4);
    const front = read(4),
      side = read(4),
      back = read(4),
      lfe = read(2),
      assoc = read(3),
      cc = read(4);
    if (read(1)) read(4);
    if (read(1)) read(4);
    if (read(1)) read(3);
    let pairs = 0;
    for (let i = 0; i < front + side + back; i++) {
      pairs += read(1);
      read(4);
    }
    for (let i = 0; i < lfe + assoc; i++) read(4);
    for (let i = 0; i < cc; i++) read(5);
    bit = (bit + 7) & ~7;
    const comments = read(8);
    for (let i = 0; i < comments; i++) read(8);
    return { dual: front === 2 && side === 0 && back === 0 && lfe === 0 && pairs === 0 };
  } catch {
    return null;
  }
}

// Preserve the receiver's linear interpolation and final-sample clamping.
// Matching rates reuse each channel's buffer for the existing worker transfer.
export function resampleChannels(channels, sourceRate, targetRate) {
  return channels.map((samples) => {
    if (sourceRate === targetRate) return samples;
    const output = new Float32Array(Math.round((samples.length * targetRate) / sourceRate));
    for (let index = 0; index < output.length; index++) {
      const position = (index * sourceRate) / targetRate;
      const left = Math.floor(position);
      const fraction = position - left;
      const right = Math.min(left + 1, samples.length - 1);
      output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
    }
    return output;
  });
}

// Read-only metadata extraction. Parsing is shared with the playback demuxer.
export function avcInformation(nal) {
  if (nal.length < 5 || nal.length > 4096 || nal[0] & 0x80 || (nal[0] & 31) !== 7) return null;
  const sps = parseAvcSps(nal);
  if (
    !sps ||
    sps.displayWidth <= 0 ||
    sps.displayHeight <= 0 ||
    sps.codedWidth > 8192 ||
    sps.codedHeight > 8192 ||
    sps.bitDepthLumaMinus8 > 8 ||
    sps.bitDepthChromaMinus8 > 8
  )
    return null;
  return {
    codec:
      'avc1.' +
      [sps.profileIdc, sps.constraintFlags, sps.levelIdc]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join(''),
    profile: sps.profileIdc,
    constraints: sps.constraintFlags,
    level: sps.levelIdc,
    width: sps.displayWidth,
    height: sps.displayHeight,
    codedWidth: sps.codedWidth,
    codedHeight: sps.codedHeight,
    progressive: !!sps.frameMbsOnlyFlag,
    chroma: sps.chromaFormatIdc,
    lumaDepth: sps.bitDepthLumaMinus8 + 8,
    chromaDepth: sps.bitDepthChromaMinus8 + 8,
    sar: [sps.pixelAspectRatio.num, sps.pixelAspectRatio.den],
    fullRange: !!sps.fullRangeFlag,
    colourPrimaries: sps.colourPrimaries,
    transferCharacteristics: sps.transferCharacteristics,
    matrixCoefficients: sps.matrixCoefficients,
    timingRate: sps.timingFrameDuration > 0 ? 1 / sps.timingFrameDuration : undefined,
  };
}
export function aacInformation(adts) {
  try {
    if (adts.length < 7 || adts[0] !== 255 || (adts[1] & 0xf6) !== 0xf0) return null;
    const frequencyIndex = (adts[2] >> 2) & 15,
      coreSampleRate = AAC_RATES[frequencyIndex];
    if (!coreSampleRate) return null;
    const objectType = (adts[2] >> 6) + 1,
      channelConfiguration = ((adts[2] & 1) << 2) | (adts[3] >> 6);
    const pce = channelConfiguration === 0 ? aacProgramConfig(adts) : null;
    return {
      mpegVersion: adts[1] & 8 ? 2 : 4,
      objectType,
      coreSampleRate,
      frequencyIndex,
      channelConfiguration,
      crcPresent: !(adts[1] & 1),
      rawDataBlocks: (adts[6] & 3) + 1,
      ...(pce ? { dual: pce.dual } : {}),
    };
  } catch {
    return null;
  }
}
