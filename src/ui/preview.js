import { Frame } from '../core/image/frame.js';
import { darkenMaskOverlay } from './overlay.js';

/**
 * Preview renderer.
 *
 * Shows before/after with a movable split, at panel resolution. The mask overlay
 * draws the actual coverage field the engine will hand to Photoshop, so the
 * retoucher can verify the selection before committing 40 layers.
 */
export class PreviewView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.before = null;
    this.after = null;
    this.mask = null;
    this.split = 0.5;
    this.compare = true;
    this.showMask = false;
  }

  setFrames({ before, after, mask = null }) {
    this.before = before;
    this.after = after || (before ? before.clone() : null);
    this.mask = mask;
    this.draw();
  }

  setAfter(after) {
    this.after = after;
    this.draw();
  }

  setMask(mask) {
    this.mask = mask;
    this.draw();
  }

  setSplit(percent) {
    this.split = Math.max(0, Math.min(1, percent / 100));
    this.draw();
  }

  setCompare(enabled) {
    this.compare = Boolean(enabled);
    this.draw();
  }

  setShowMask(enabled) {
    this.showMask = Boolean(enabled);
    this.draw();
  }

  draw() {
    if (!this.before || !this.ctx) return;
    const { width, height } = this.before;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const beforeRGBA = this.before.toRGBA();
    const after = this.after || this.before;
    const afterRGBA = after === this.before ? beforeRGBA : after.toRGBA();

    const composed = new Uint8ClampedArray(beforeRGBA.length);
    if (!this.compare) {
      composed.set(afterRGBA);
    } else {
      const splitX = Math.round(width * this.split);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const src = x < splitX ? beforeRGBA : afterRGBA;
          composed[i] = src[i];
          composed[i + 1] = src[i + 1];
          composed[i + 2] = src[i + 2];
          composed[i + 3] = 255;
        }
      }
    }

    if (this.showMask && this.mask) {
      darkenMaskOverlay(composed, this.mask, width, height, 0.62);
    }

    const imageData = this.ctx.createImageData
      ? this.ctx.createImageData(width, height)
      : new ImageData(width, height);
    imageData.data.set(composed);
    this.ctx.putImageData(imageData, 0, 0);
  }

  /** Resize a document-resolution frame pair down for the panel. */
  static fit(frame, maxEdge = 900) {
    const scale = Math.min(1, maxEdge / Math.max(frame.width, frame.height));
    if (scale >= 0.999) return frame;
    return frame.resize(Math.max(1, Math.round(frame.width * scale)), Math.max(1, Math.round(frame.height * scale)));
  }
}

/** Test helper: deterministic gradient frame without a canvas. */
export const placeholderFrame = (width = 240, height = 320) => {
  const f = new Frame(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      f.r[i] = 40 + (x / width) * 60;
      f.g[i] = 30 + (y / height) * 50;
      f.b[i] = 70 + (x / width) * 30;
    }
  }
  return f;
};
