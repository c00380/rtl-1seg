import { messages } from '../messages.js';
import { TMCC_GENERATOR, remainder } from './physical.js';
// Read-only presentation decoding of the DSP's versioned TMCC/AC snapshot.
const value = (bits, start, length) =>
  bits.slice(start, start + length).reduce((n, b) => n * 2 + b, 0);
const sync = (bits) => [0x35ee, 0xca11].includes(value(bits, 1, 16));
function layer(bits, start) {
  const modulation = value(bits, start, 3),
    rate = value(bits, start + 3, 3),
    interleave = value(bits, start + 6, 3),
    segments = value(bits, start + 9, 4);
  return { modulation, rate, interleave, segments };
}
const areas = messages.broadcast.targetRegions.split(',');
export function readPhysicalInformation(bytes) {
  if (bytes?.length !== 412 || bytes[0] !== 1 || bytes[1] > 1 || bytes[2] > 4 || bytes[3] !== 0)
    return null;
  const t = Array.from(bytes.slice(4, 208)),
    a = Array.from(bytes.slice(208));
  if ([...t, ...a].some((bit) => bit !== 0 && bit !== 1)) return null;
  const tmcc =
    bytes[1] && sync(t) && remainder(t.slice(20), TMCC_GENERATOR, 82) === 0n
      ? {
          system: value(t, 20, 2),
          segmentType: value(t, 17, 3),
          switchCountdown: value(t, 22, 4),
          ews: value(t, 26, 1),
          partial: value(t, 27, 1),
          current: [28, 41, 54].map((start) => layer(t, start)),
          nextPartial: value(t, 67, 1),
          next: [68, 81, 94].map((start) => layer(t, start)),
          connectedPhase: value(t, 107, 3),
          reserved: value(t, 110, 12),
        }
      : null;
  let ac = { status: 'waiting' };
  if (bytes[2] === 1 && a.slice(1).every((bit) => bit === 1)) ac = { status: 'idle' };
  else if (
    bytes[2] === 2 &&
    sync(a) &&
    remainder(a.slice(17), TMCC_GENERATOR, 82) === 0n &&
    remainder(a.slice(21, 122), 0x633n, 10) === 0n
  ) {
    const startEnd = value(a, 17, 2),
      identification = value(a, 21, 3);
    ac = { status: 'validated', startEnd, update: value(a, 19, 2), identification };
    if (startEnd === 3 && identification === 7) ac.broadcasterId = value(a, 56, 11);
    if (startEnd === 0 && identification < 4) {
      ac.currentTimeCode = value(a, 24, 31);
      ac.page = value(a, 55, 1);
      if (ac.page === 0) ac.targetAreas = areas.filter((_, i) => a[56 + i] === 0);
      else {
        ac.earthquakeCount = a[56] + 1;
        ac.earthquakeIndex = a[57] + 1;
        ac.warningId = value(a, 58, 9);
        ac.cancelled = Boolean(a[67]);
        if (!ac.cancelled) {
          ac.latitude = ((a[68] ? -1 : 1) * value(a, 69, 10)) / 10;
          ac.longitude = ((a[79] ? -1 : 1) * value(a, 80, 11)) / 10;
          ac.depthKm = value(a, 91, 10);
          ac.occurrenceTimeCode = value(a, 101, 10);
        }
      }
    }
  } else if (bytes[2] !== 0) ac = { status: 'unverified', configuration: value(a, 1, 3) };
  return { tmcc, ac };
}
