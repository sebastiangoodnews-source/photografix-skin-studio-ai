import { clamp } from '../util/math.js';

/**
 * Histogram and exposure analysis. Every engine that decides "should I brighten
 * this" asks this module first, so the whole suite reacts consistently to a
 * document's actual tonal distribution.
 */

export const LUMA_BINS = 256;

export const computeHistogram = (frame) => {
  const hist = new Uint32Array(LUMA_BINS);
  const [r, g, b] = frame.channels;
  const n = frame.pixelCount;
  for (let i = 0; i < n; i++) {
    const y = 0.2126 * r[i] + 0.7152 * g[i] + 0.0722 * b[i];
    hist[clamp(Math.round(y), 0, 255)]++;
  }
  return hist;
};

export const percentileFromHistogram = (hist, p) => {
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i];
  if (!total) return 0;
  const target = total * clamp(p);
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return hist.length - 1;
};

export const lumaArray = (frame) => {
  const [r, g, b] = frame.channels;
  const out = new Float32Array(frame.pixelCount);
  for (let i = 0; i < out.length; i++) out[i] = 0.2126 * r[i] + 0.7152 * g[i] + 0.0722 * b[i];
  return out;
};

export const analyseExposure = (frame) => {
  const hist = computeHistogram(frame);
  const total = frame.pixelCount || 1;
  const clippedHighlights = (hist[255] + hist[254]) / total;
  const clippedShadows = (hist[0] + hist[1]) / total;
  const median = percentileFromHistogram(hist, 0.5);
  const p05 = percentileFromHistogram(hist, 0.05);
  const p95 = percentileFromHistogram(hist, 0.95);
  const dynamicRange = Math.max(1, p95 - p05);
  const mean = lumaArray(frame).reduce((a, v) => a + v, 0) / Math.max(1, total);
  let classification = 'normal';
  if (median < 58) classification = 'low-key';
  else if (median > 190) classification = 'high-key';
  return {
    histogram: hist,
    medianLuma: median,
    meanLuma: mean,
    p05,
    p95,
    dynamicRange,
    clippedHighlightsPct: clippedHighlights * 100,
    clippedShadowsPct: clippedShadows * 100,
    classification,
    headroomHighlights: 255 - p95,
    headroomShadows: p05,
  };
};

/**
 * Where the key light appears to sit, inferred from the photograph itself.
 *
 * Method: the bright side of a subject is the lit side. We take a robust exposure
 * reference (luminance median) and compute the centroid of "above median" weight;
 * the vector from the subject centroid to the bright centroid is the direction the
 * light comes FROM. This is melanin-neutral (deep and fair skin both have a bright
 * side) and immune to a single hot specular, which a raw gradient vote is not.
 */
export const estimateLightDirection = (frame) => {
  const luma = lumaArray(frame);
  const { width, height } = frame;
  const n = luma.length;

  // robust median + upper reference from a strided sample
  const samples = [];
  const stride = Math.max(1, Math.floor(n / 6000));
  for (let i = 0; i < n; i += stride) samples.push(luma[i]);
  samples.sort((a, b) => a - b);
  const median = samples[samples.length >> 1] || 0;
  const p90 = samples[Math.floor(samples.length * 0.9)] || 255;
  const threshold = median + (p90 - median) * 0.35;

  let wSum = 0;
  let wx = 0;
  let wy = 0;
  let totalX = 0;
  let totalY = 0;
  let totalW = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const weight = Math.max(0, luma[i] - threshold);
      totalX += x;
      totalY += y;
      totalW++;
      if (weight > 0) {
        wSum += weight;
        wx += weight * x;
        wy += weight * y;
      }
    }
  }
  if (wSum <= 1e-6 || !totalW) {
    return { x: -0.35, y: -0.55, confidence: 0.15, source: 'default-upper-left', median };
  }
  const brightX = wx / wSum;
  const brightY = wy / wSum;
  const cx = totalX / totalW;
  const cy = totalY / totalW;
  // vector from the subject centre to the bright centroid = direction to the light
  const dx = brightX - cx;
  const dy = brightY - cy;
  const mag = Math.hypot(dx, dy);
  const normaliser = Math.max(1, Math.min(width, height) * 0.5);
  const confidence = Math.min(1, mag / normaliser) * Math.min(1, wSum / (n * 0.02));
  return {
    x: mag > 1e-6 ? dx / mag : -0.35,
    y: mag > 1e-6 ? dy / mag : -0.55,
    confidence,
    source: 'bright-centroid',
    median,
  };
};

/** Sharpness estimate (variance of Laplacian) used to pick preview scale. */
export const estimateSharpness = (frame) => {
  const luma = lumaArray(frame);
  const { width, height } = frame;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
};
