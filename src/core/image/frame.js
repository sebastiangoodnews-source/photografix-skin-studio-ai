import { clamp } from '../util/math.js';

/**
 * Frame: the engine-wide image container.
 *
 * Layout is planar (three Float32Array channels + one mask channel) because every
 * processing module in this plugin operates on one channel list at a time; planar
 * storage keeps gaussian blur / morphology / blend kernels allocation-light.
 *
 * All channel values are 0..255 float. The mask channel is 0..1.
 * Frames are mutable by design; every engine returns a NEW frame rather than
 * mutating its input, so the non-destructive layer stack can hold references to
 * intermediate results.
 */

export class Frame {
  constructor(width, height, data) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new TypeError(`Frame: invalid dimensions ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.pixelCount = width * height;
    if (data) {
      this.channels = data.map((c) => {
        if (!(c instanceof Float32Array)) throw new TypeError('Frame: channels must be Float32Array');
        if (c.length !== this.pixelCount) throw new RangeError('Frame: channel length mismatch');
        return c;
      });
    } else {
      this.channels = [new Float32Array(this.pixelCount), new Float32Array(this.pixelCount), new Float32Array(this.pixelCount)];
    }
    this.mask = null;
  }

  get r() {
    return this.channels[0];
  }

  get g() {
    return this.channels[1];
  }

  get b() {
    return this.channels[2];
  }

  static zeros(width, height) {
    return new Frame(width, height);
  }

  static fromRGBA(width, height, rgba) {
    const n = width * height;
    if (rgba.length < n * 4) throw new RangeError('Frame.fromRGBA: source buffer too small');
    const r = new Float32Array(n);
    const g = new Float32Array(n);
    const b = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      r[i] = rgba[j];
      g[i] = rgba[j + 1];
      b[i] = rgba[j + 2];
    }
    return new Frame(width, height, [r, g, b]);
  }

  static fromRGBFlat(width, height, flat) {
    const n = width * height;
    if (flat.length < n * 3) throw new RangeError('Frame.fromRGBFlat: source buffer too small');
    const r = new Float32Array(n);
    const g = new Float32Array(n);
    const b = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      r[i] = flat[j];
      g[i] = flat[j + 1];
      b[i] = flat[j + 2];
    }
    return new Frame(width, height, [r, g, b]);
  }

  clone() {
    const f = new Frame(
      this.width,
      this.height,
      this.channels.map((c) => Float32Array.from(c)),
    );
    if (this.mask) f.mask = Float32Array.from(this.mask);
    return f;
  }

  /** RGBA Uint8ClampedArray, alpha 255. Ready for putImageData. */
  toRGBA(out) {
    const n = this.pixelCount;
    const buf = out || new Uint8ClampedArray(n * 4);
    const [r, g, b] = this.channels;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      buf[j] = clamp(r[i], 0, 255);
      buf[j + 1] = clamp(g[i], 0, 255);
      buf[j + 2] = clamp(b[i], 0, 255);
      buf[j + 3] = 255;
    }
    return buf;
  }

  /** Raw RGB triplets, used by the Photoshop capture / export path. */
  toRGBFlat(out) {
    const n = this.pixelCount;
    const buf = out || new Float32Array(n * 3);
    const [r, g, b] = this.channels;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      buf[j] = clamp(r[i], 0, 255);
      buf[j + 1] = clamp(g[i], 0, 255);
      buf[j + 2] = clamp(b[i], 0, 255);
    }
    return buf;
  }

  sample(x, y) {
    const px = clamp(Math.round(x), 0, this.width - 1);
    const py = clamp(Math.round(y), 0, this.height - 1);
    const i = py * this.width + px;
    return { r: this.r[i], g: this.g[i], b: this.b[i] };
  }

  maskAt(x, y) {
    if (!this.mask) return 1;
    const px = clamp(Math.round(x), 0, this.width - 1);
    const py = clamp(Math.round(y), 0, this.height - 1);
    return this.mask[py * this.width + px];
  }

  ensureMask(fill = 1) {
    if (!this.mask) this.mask = new Float32Array(this.pixelCount).fill(fill);
    return this.mask;
  }

  /**
   * Resample to the given size (box average when downscaling, bilinear upscaling).
   * Used for previewing engines at panel resolution without changing the output size.
   */
  resize(width, height) {
    const out = new Frame(width, height);
    const xRatio = this.width / width;
    const yRatio = this.height / height;
    const downscale = xRatio > 1 || yRatio > 1;
    for (let ch = 0; ch < 3; ch++) {
      const src = this.channels[ch];
      const dst = out.channels[ch];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let value;
          if (downscale) {
            const x0 = Math.floor(x * xRatio);
            const x1 = Math.max(x0 + 1, Math.min(this.width, Math.ceil((x + 1) * xRatio)));
            const y0 = Math.floor(y * yRatio);
            const y1 = Math.max(y0 + 1, Math.min(this.height, Math.ceil((y + 1) * yRatio)));
            let sum = 0;
            let count = 0;
            for (let sy = y0; sy < y1; sy++) {
              const row = sy * this.width;
              for (let sx = x0; sx < x1; sx++) {
                sum += src[row + sx];
                count++;
              }
            }
            value = count ? sum / count : src[(y0 * this.width + x0) | 0];
          } else {
            const fx = Math.min(this.width - 1, (x + 0.5) * xRatio - 0.5);
            const fy = Math.min(this.height - 1, (y + 0.5) * yRatio - 0.5);
            const x0 = Math.max(0, Math.floor(fx));
            const y0 = Math.max(0, Math.floor(fy));
            const x1 = Math.min(this.width - 1, x0 + 1);
            const y1 = Math.min(this.height - 1, y0 + 1);
            const tx = fx - x0;
            const ty = fy - y0;
            const v00 = src[y0 * this.width + x0];
            const v10 = src[y0 * this.width + x1];
            const v01 = src[y1 * this.width + x0];
            const v11 = src[y1 * this.width + x1];
            value = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
          }
          dst[y * width + x] = value;
        }
      }
    }
    if (this.mask) {
      const srcMask = this.mask;
      const dstMask = new Float32Array(width * height);
      for (let y = 0; y < height; y++) {
        const sy = Math.min(this.height - 1, Math.floor(y * yRatio));
        for (let x = 0; x < width; x++) {
          const sx = Math.min(this.width - 1, Math.floor(x * xRatio));
          dstMask[y * width + x] = srcMask[sy * this.width + sx];
        }
      }
      out.mask = dstMask;
    }
    return out;
  }

  /** Apply the frame mask (or a supplied one) into the RGB channels. */
  applyMask(mask = this.mask) {
    if (!mask) return this;
    const [r, g, b] = this.channels;
    for (let i = 0; i < this.pixelCount; i++) {
      const m = mask[i];
      r[i] *= m;
      g[i] *= m;
      b[i] *= m;
    }
    return this;
  }
}

/** Composite `top` over `bottom` using `top.mask` as the alpha channel. */
export const over = (bottom, top) => {
  const out = bottom.clone();
  const mask = top.mask;
  const [r, g, b] = out.channels;
  for (let i = 0; i < out.pixelCount; i++) {
    const a = mask ? mask[i] : 1;
    if (a <= 0) continue;
    r[i] = r[i] * (1 - a) + top.r[i] * a;
    g[i] = g[i] * (1 - a) + top.g[i] * a;
    b[i] = b[i] * (1 - a) + top.b[i] * a;
  }
  return out;
};

/** Deterministic small synthetic test image (used by tests and the dev harness). */
export const syntheticPortrait = (width = 128, height = 160, options = {}) => {
  const { skin = [132, 84, 58], seed = 1, texture = 6 } = options;
  const f = new Frame(width, height);
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const cx = width / 2;
  const cy = height * 0.42;
  const rx = width * 0.26;
  const ry = height * 0.3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const d = dx * dx + dy * dy;
      const inFace = d <= 1;
      const inBody = Math.abs(x - cx) < width * 0.34 && y > height * 0.66;
      const base = inFace || inBody ? 1 : 0;
      // soft directional lighting from upper-left
      const light = 1.14 - 0.3 * (x / width) - 0.12 * (y / height);
      const grain = (rnd() - 0.5) * texture;
      const cheek = inFace ? Math.max(0, 1 - Math.abs(d - 0.55) * 6) * 6 : 0;
      for (let c = 0; c < 3; c++) {
        const bg = c === 0 ? 26 : c === 1 ? 30 : 44;
        const sk = skin[c] * light + grain + (c === 0 ? cheek : 0);
        f.channels[c][i] = base ? sk : bg;
      }
    }
  }
  return f;
};
