import { messages } from '../messages.js';
// Broadcast component labels shared by programme information and track choices.
// Callers retain their existing fallback for absent or reserved component types.
const AUDIO_LAYOUTS = {
  1: messages.broadcast.mono,
  2: messages.broadcast.dualAudio,
  3: messages.broadcast.stereo,
  7: '3/1',
  8: '3/2',
  9: '5.1ch',
};

export function audioLayout(type, fallback = '') {
  return AUDIO_LAYOUTS[type] || fallback;
}
