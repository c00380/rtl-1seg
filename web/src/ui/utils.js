// DOM mutations shared by views. Keep text safe and avoid redundant updates.
export function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

export function setAttribute(element, name, value) {
  const next = String(value);
  if (element.getAttribute(name) !== next) element.setAttribute(name, next);
}

export function setAria(element, name, value) {
  setAttribute(element, `aria-${name}`, value);
}

// 表示用の共通整形。受信値の解析・補正は行わない。
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const numberFormats = new Map();

export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);

export function formatNumber(value, digits = 2, unit = '') {
  if (!Number.isFinite(value)) return null;
  if (!numberFormats.has(digits)) {
    numberFormats.set(
      digits,
      new Intl.NumberFormat('ja-JP', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }),
    );
  }
  return `${numberFormats.get(digits).format(value)}${unit}`;
}
