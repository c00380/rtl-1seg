import { ARIBB24JapaneseJIS8Encoder } from 'aribb24.js';
import overrides from './si-text-overrides.json';

// SI uses the existing JIS repertoire, not the caption encoder's symbol rows.
// Its extra symbols overwrite 69 standard JIS mappings; preserve the SI codes
// on a separate Map without modifying the library's shared caption table.
export const siKanji = new Map(
  [...ARIBB24JapaneseJIS8Encoder.KANJI].filter(([, pair]) => pair[0] <= 0x74),
);
for (const [character, pair] of Object.entries(overrides)) siKanji.set(character, pair);
