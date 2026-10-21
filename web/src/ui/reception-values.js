import { messages } from '../messages.js';

const labels = messages.details;
const languages = new Intl.DisplayNames(['ja'], { type: 'language' });
export const receptionCode = (value, digits = 4) =>
  Number.isInteger(value)
    ? `${value}（0x${value.toString(16).toUpperCase().padStart(digits, '0')}）`
    : null;
const described = (value, meaning) => `${receptionCode(value, 2)} · ${meaning}`;

export function receptionLanguage(value) {
  const language = Number.isInteger(value)
    ? String.fromCharCode((value >>> 16) & 255, (value >>> 8) & 255, value & 255)
    : value;
  if (typeof language !== 'string' || !/^[a-z]{3}$/.test(language))
    return Number.isInteger(value) ? receptionCode(value, 6) : value;
  const name = languages.of(language);
  const text = name === language ? language : `${name} / ${language}`;
  return Number.isInteger(value) ? `${text} · ${receptionCode(value, 6)}` : text;
}

// Meanings depend on the enclosing descriptor, especially its copy_control_type.
// Unknown codes remain visible without assigning them a guessed meaning.
export function receptionValue(key, value, parent = {}, context = parent.tag) {
  if (value == null) return null;
  if (key === 'iso639LanguageCode' || key === 'iso_639_language_code')
    return receptionLanguage(value);
  if (typeof value !== 'number') return value;
  if (context === 'digitalCopyControl' && key === 'apsControlData')
    return described(
      value,
      parent.copyControlType === 1
        ? (labels.apsModes[value] ?? labels.uninterpreted)
        : labels.apsReserved,
    );
  if (context === 'caption') {
    if (key === 'displayMode')
      return described(
        value,
        labels.captionDisplayMode(
          value >> 2 === 3
            ? labels.captionConditional
            : (labels.captionDisplayModes[value >> 2] ?? labels.uninterpreted),
          labels.captionDisplayModes[value & 3] ?? labels.reserved,
        ),
      );
    if (key === 'format')
      return described(value, labels.captionFormats[value] ?? labels.uninterpreted);
    if (key === 'TCS')
      return described(value, labels.captionCharacterSets[value] ?? labels.reserved);
    if (key === 'rollup') return described(value, labels.rollupModes[value] ?? labels.reserved);
  }
  if (['colourPrimaries', 'transferCharacteristics', 'matrixCoefficients'].includes(key))
    return described(value, labels.colourCodes[value] ?? labels.uninterpreted);
  if (key === 'serviceType')
    return described(value, labels.serviceTypes[value] ?? labels.uninterpreted);
  if (key === 'runningStatus')
    return described(value, labels.runningStatuses[value] ?? labels.reserved);
  if (key === 'transmissionTypeInfo')
    return described(
      value,
      labels.transmissionTypeValue(
        labels.transmissionTypes[value >> 6] ?? labels.uninterpreted,
        labels.transmissionModulations[(value >> 4) & 3],
        value & 15,
      ),
    );
  return /(?:id|pid|tag|code|type)$/i.test(key) ? receptionCode(value) : value;
}
