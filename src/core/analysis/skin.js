import { clamp, luma } from '../util/math.js';
import { rgbToLab, rgbToLch } from '../image/colorspace.js';
import { guidedFilter, softThreshold, boxMean } from '../image/morphology.js';

/**
 * Skin science primitives.
 *
 * The membership test is deliberately melanin-inclusive: it keys off chroma
 * relationships (a-star/b-star ratio) rather than absolute luminance, so deep chocolate
 * and fair skin both score high. A luminance-only threshold is the classic bug
 * that makes retouching tools ignore dark skin.
 */

export const SKIN_L_RANGE = [4, 99];

/**
 * Soft skin membership in 0..1.
 * Works across the full melanin range: the a-star/b-star window narrows as skin darkens
 * because deep skin has less absolute chroma in Lab despite strong saturation.
 */
export const skinProbability = (r, g, b) => {
  const { L, a, b: bb } = rgbToLab(r, g, b);
  if (L < SKIN_L_RANGE[0] || L > SKIN_L_RANGE[1]) return 0;

  // Hue window: skin lies between red-orange and orange-yellow (Lab hue angle).
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  const hueScore = gaussianWindow(hue, 46, 34);

  // Chroma: rises with melanin richness but plateaus; never require brightness.
  const chroma = Math.sqrt(a * a + bb * bb);
  const chromaScore = smoothBand(chroma, 3.5, 11, 52, 68);

  // Deep skin: keep more of the red axis than the yellow axis (a* > b* often).
  const ratio = a > 0.1 ? bb / a : 9;
  const ratioScore = smoothBand(ratio, 0.05, 0.3, 3.2, 5.4);

  // Reject obviously cool/neutral surfaces (walls, grey clothing).
  const warmth = a + bb * 0.5;
  const warmthScore = smoothBand(warmth, -4, 1, 90, 120);

  return clamp(hueScore * 0.34 + chromaScore * 0.28 + ratioScore * 0.2 + warmthScore * 0.18);
};

const gaussianWindow = (v, centre, spread) => {
  const d = (v - centre) / spread;
  return Math.exp(-0.5 * d * d);
};

const smoothBand = (v, loFeatherStart, lo, hi, hiFeatherEnd) => {
  if (v <= loFeatherStart) return 0;
  if (v < lo) return smooth01((v - loFeatherStart) / (lo - loFeatherStart));
  if (v <= hi) return 1;
  if (v < hiFeatherEnd) return smooth01(1 - (v - hi) / (hiFeatherEnd - hi));
  return 0;
};

const smooth01 = (t) => {
  const c = clamp(t);
  return c * c * (3 - 2 * c);
};

/** Full per-pixel skin probability field for a frame. */
export const skinProbabilityField = (frame, options = {}) => {
  const { width, height } = frame;
  const [r, g, b] = frame.channels;
  const n = frame.pixelCount;
  const field = new Float32Array(n);
  for (let i = 0; i < n; i++) field[i] = skinProbability(r[i], g[i], b[i]);
  // Denoise the field; probabilities are spatially coherent on real faces.
  const radius = Math.max(1, Math.round(((options.smoothRadius ?? 0.004) * Math.min(width, height)) || 2));
  const smoothed = boxMean(field, width, height, radius);
  return options.keepRaw ? { field, smoothed } : smoothed;
};

export const skinMask = (frame, options = {}) => {
  const prob = skinProbabilityField(frame, options);
  const low = options.low ?? 0.28;
  const high = options.high ?? 0.62;
  const mask = softThreshold(prob, low, high);
  if (options.refine !== false) {
    const guide = lumaField(frame, options.guideScale ?? 255);
    return guidedFilter(mask, guide, frame.width, frame.height, options.radius ?? 3, options.eps ?? 0.002);
  }
  return mask;
};

export const lumaField = (frame, scale = 255) => {
  const [r, g, b] = frame.channels;
  const out = new Float32Array(frame.pixelCount);
  for (let i = 0; i < out.length; i++) out[i] = luma(r[i], g[i], b[i]) / scale;
  return out;
};

/**
 * Melanin index 0 (fair) .. 1 (deepest). Derived from Lab L and chroma so it is
 * independent of exposure within reason.
 */
export const melaninIndex = (L, C) => {
  const lScore = clamp((88 - L) / 80);
  const cScore = clamp((C - 8) / 45);
  return clamp(lScore * 0.82 + cScore * 0.18);
};

/** Undertone classification from Lab hue angle. */
export const classifyUndertone = (lab) => {
  const hue = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (hue < 38) return 'red';
  if (hue < 50) return 'red-orange';
  if (hue < 62) return 'orange';
  if (hue < 74) return 'golden';
  return 'olive';
};

/**
 * Summarise the skin present in a mask: median Lab, melanin index, undertone,
 * dynamic range, and per-zone consistency. Feeds the Skin Tone Studio.
 */
export const summariseSkin = (frame, mask) => {
  const [r, g, b] = frame.channels;
  const n = frame.pixelCount;
  const samples = { L: [], a: [], b: [], luma: [] };
  let totalWeight = 0;
  for (let i = 0; i < n; i++) {
    const w = mask ? mask[i] : 1;
    if (w < 0.15) continue;
    totalWeight += w;
    if (samples.L.length < 20000 || (i & 7) === 0) {
      const lab = rgbToLab(r[i], g[i], b[i]);
      samples.L.push(lab.L);
      samples.a.push(lab.a);
      samples.b.push(lab.b);
      samples.luma.push(luma(r[i], g[i], b[i]));
    }
  }
  if (!samples.L.length) return null;
  const med = (arr) => {
    const c = Float32Array.from(arr);
    c.sort();
    return c[c.length >> 1];
  };
  const L = med(samples.L);
  const a = med(samples.a);
  const bb = med(samples.b);
  const C = Math.sqrt(a * a + bb * bb);
  const lumaMed = med(samples.luma);
  const lumaP10 = samples.luma.slice().sort((x, y) => x - y)[Math.floor(samples.luma.length * 0.1)];
  const lumaP90 = samples.luma.slice().sort((x, y) => x - y)[Math.floor(samples.luma.length * 0.9)];
  return {
    pixelWeight: totalWeight,
    coverage: totalWeight / n,
    lab: { L, a, b: bb },
    lch: rgbToLch(r[0], g[0], b[0]) && { L, C, H: (Math.atan2(bb, a) * 180) / Math.PI },
    chroma: C,
    melanin: melaninIndex(L, C),
    undertone: classifyUndertone({ L, a, b: bb }),
    lumaMedian: lumaMed,
    lumaP10,
    lumaP90,
    tonalRange: lumaP90 - lumaP10,
  };
};
