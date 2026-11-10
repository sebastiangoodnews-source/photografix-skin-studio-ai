/**
 * Numeric helpers shared by every processing module.
 * No dependencies, deterministic, safe on NaN / Infinity input.
 */

export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

export const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

export const lerp = (a, b, t) => a + (b - a) * t;

export const smoothstep = (edge0, edge1, x) => {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** Perceptual luminance of linear-ish sRGB values in 0..255 space. */
export const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export const srgbToLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

export const linearToSrgb = (v) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return c * 255;
};

export const mean = (arr) => {
  if (!arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
};

export const stdDev = (arr) => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    s += d * d;
  }
  return Math.sqrt(s / arr.length);
};

/** Percentile of an unsorted array (0..1). Copies before sorting. */
export const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const copy = Float32Array.from(arr);
  copy.sort();
  const idx = clamp(Math.round((copy.length - 1) * p), 0, copy.length - 1);
  return copy[idx];
};

export const mix = (a, b, t) => a + (b - a) * t;

export const deg2rad = (d) => (d * Math.PI) / 180;
export const rad2deg = (r) => (r * 180) / Math.PI;

/** 1D gaussian kernel (normalised). */
export const gaussianKernel1D = (sigma) => {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const size = radius * 2 + 1;
  const k = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    k[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += k[i];
  }
  for (let i = 0; i < size; i++) k[i] /= sum;
  return { kernel: k, radius };
};

/** Deterministic PRNG so previews and tests are reproducible. */
export const makeRng = (seed = 0x9e3779b9) => {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
};

export const roundTo = (v, step) => Math.round(v / step) * step;

export const isFinitePositive = (v) => Number.isFinite(v) && v > 0;
