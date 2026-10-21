import { messages } from '../messages.js';
import { setText } from './utils.js';
import {
  ARIBB24Parser,
  canvasRenderingStrategy,
  CanvasRenderingOption,
  additionalSymbolGlyphs,
} from '../../vendor/arib-caption.js';
// Move the complete rendered caption together, preserving DRCS and line spacing.
export function captionBounds({ data, width, height }) {
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0, alpha = 3; y < height; y++)
    for (let x = 0; x < width; x++, alpha += 4) {
      if (!data[alpha]) continue;
      if (x < left) left = x;
      if (y < top) top = y;
      if (x > right) right = x;
      bottom = y;
    }
  return right < left
    ? null
    : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
export function captionPlacement(bounds, width, height) {
  const unit = Math.min(width / 320, height / 180),
    side = 10 * unit,
    bottom = 8 * unit;
  const scale = Math.min(unit, (width - side * 2) / bounds.width, height / 3 / bounds.height);
  const w = bounds.width * scale,
    h = bounds.height * scale;
  return { x: (width - w) / 2, y: height - bottom - h, width: w, height: h };
}

export class CaptionView {
  constructor(
    canvas,
    button,
    enabled = false,
    {
      createCanvas = () => document.createElement('canvas'),
      render = canvasRenderingStrategy,
    } = {},
  ) {
    this.canvas = canvas;
    this.button = button;
    this.enabled = enabled;
    this.available = true;
    this.canvas.hidden = !enabled;
    this.createCanvas = createCanvas;
    this.render = render;
    this.buffer = null;
    // Broadcast-specific symbols use bundled outlines rather than OS fonts.
    // Downloaded DRCS bitmaps continue to use their original broadcast shape.
    this.options = CanvasRenderingOption.from({
      color: { stroke: '#000000' },
      replace: { glyph: additionalSymbolGlyphs },
    });
    button.onclick = () => {
      if (!this.available) return;
      this.setEnabled(!this.enabled);
    };
    this.updateButton();
  }
  setAvailable(available) {
    this.available = available;
    this.button.disabled = !available;
    this.canvas.hidden = !available || !this.enabled;
    this.updateButton();
  }
  setEnabled(enabled) {
    this.enabled = !!enabled;
    this.canvas.hidden = !this.available || !this.enabled;
    this.updateButton();
  }
  updateButton() {
    const button = this.button;
    setText(
      button,
      this.available ? messages.common.captionState(this.enabled ? 'ON' : 'OFF') : '',
    );
    button.setAttribute('aria-pressed', String(this.available && this.enabled));
  }
  clear() {
    this.canvas.getContext('2d').clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.buffer?.getContext('2d').clearRect(0, 0, this.buffer.width, this.buffer.height);
  }
  draw(tokens) {
    if (!tokens.length) {
      this.clear();
      return;
    }
    if (!this.buffer) {
      this.buffer = this.createCanvas();
      this.buffer.width = 320;
      this.buffer.height = 180;
    }
    // Some received DRCS glyphs extend past the last character cell. Preserve
    // their full bitmap before fitting the complete caption into the overlay.
    let width = this.buffer.width,
      height = this.buffer.height;
    for (const token of tokens) {
      if (token.tag !== 'DRCS' || !token.state) continue;
      const { state, option } = token,
        offset = ARIBB24Parser.offset(state),
        box = ARIBB24Parser.box(state);
      width = Math.max(
        width,
        Math.min(
          584,
          Math.ceil(
            state.margin[0] +
              state.position[0] +
              offset[0] +
              token.width * option.magnification +
              2,
          ),
        ),
      );
      height = Math.max(
        height,
        Math.min(
          444,
          Math.ceil(
            state.margin[1] +
              state.position[1] +
              1 -
              box[1] +
              offset[1] +
              token.height * option.magnification +
              2,
          ),
        ),
      );
    }
    if (width !== this.buffer.width || height !== this.buffer.height) {
      const expanded = this.createCanvas();
      expanded.width = width;
      expanded.height = height;
      expanded.getContext('2d').drawImage(this.buffer, 0, 0);
      this.buffer = expanded;
    }
    // Retain incremental drawing and timed clearing in the original caption plane.
    // Only the final overlay is positioned at the bottom of the video.
    this.render(
      this.buffer,
      globalThis.Path2D,
      [1, 1],
      tokens,
      { association: 'ARIB', language: 'jpn' },
      this.options,
    );
    const bounds = captionBounds(
      this.buffer.getContext('2d').getImageData(0, 0, this.buffer.width, this.buffer.height),
    );
    const context = this.canvas.getContext('2d');
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!bounds) {
      return;
    }
    const target = captionPlacement(bounds, this.canvas.width, this.canvas.height);
    context.drawImage(
      this.buffer,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      target.x,
      target.y,
      target.width,
      target.height,
    );
  }
}
