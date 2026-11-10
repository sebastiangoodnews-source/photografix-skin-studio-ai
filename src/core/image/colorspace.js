import { clamp, srgbToLinear, linearToSrgb } from '../util/math.js';

/**
 * Colour space conversions used by the skin-tone and grading engines.
 * All RGB values are 0..255 sRGB, Lab uses D65 white point, L in 0..100.
 */

const Xn = 0.95047;
const Yn = 1.0;
const Zn = 1.08883;

const pivot = (t) => (t > 0.008856451679 ? Math.cbrt(t) : 7.787037037 * t + 16 / 116);

export const rgbToLab = (r, g, b) => {
  const rl = srgbToLinear(clamp(r, 0, 255));
  const gl = srgbToLinear(clamp(g, 0, 255));
  const bl = srgbToLinear(clamp(b, 0, 255));
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / Xn;
  const y = (0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl) / Yn;
  const z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / Zn;
  const fx = pivot(x);
  const fy = pivot(y);
  const fz = pivot(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
};

const invPivot = (t) => {
  const t3 = t * t * t;
  return t3 > 0.008856451679 ? t3 : (t - 16 / 116) / 7.787037037;
};

export const labToRgb = (L, a, bb) => {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - bb / 200;
  const x = invPivot(fx) * Xn;
  const y = invPivot(fy) * Yn;
  const z = invPivot(fz) * Zn;
  const rl = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const gl = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return {
    r: clamp(linearToSrgb(Math.max(0, rl)), 0, 255),
    g: clamp(linearToSrgb(Math.max(0, gl)), 0, 255),
    b: clamp(linearToSrgb(Math.max(0, bl)), 0, 255),
  };
};

export const labToLch = (L, a, b) => {
  const C = Math.sqrt(a * a + b * b);
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
};

export const lchToLab = (L, C, H) => {
  const rad = (H * Math.PI) / 180;
  return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
};

export const rgbToLch = (r, g, b) => {
  const { L, a, b: bb } = rgbToLab(r, g, b);
  return labToLch(L, a, bb);
};

export const lchToRgb = (L, C, H) => {
  const { a, b } = lchToLab(L, C, H);
  return labToRgb(L, a, b);
};

export const rgbToHsl = (r, g, b) => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d > 1e-9) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  return { h: h * 360, s, l };
};

const hue2rgb = (p, q, t) => {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
};

export const hslToRgb = (h, s, l) => {
  const hn = (((h % 360) + 360) % 360) / 360;
  if (s <= 1e-9) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue2rgb(p, q, hn + 1 / 3) * 255,
    g: hue2rgb(p, q, hn) * 255,
    b: hue2rgb(p, q, hn - 1 / 3) * 255,
  };
};

/** ITU-R BT.601 skin-chroma helper: returns 0..1 "how skin-coloured" score. */
export const chromaScore = (r, g, b) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max <= 1e-6 ? 0 : (max - min) / max;
};
