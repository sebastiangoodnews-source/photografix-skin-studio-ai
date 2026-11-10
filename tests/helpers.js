import { createPortrait, TONE_PRESETS } from '../tools/lib/portrait.js';
import { RegionResolver } from '../src/core/regions/zones.js';
import { renderStack } from '../src/core/layers/render.js';
import { lumaArray } from '../src/core/analysis/histogram.js';
import { rgbToLab } from '../src/core/image/colorspace.js';

/** Small, fast fixtures for the suite (kept deterministic). */
export const smallPortrait = (tone = 'rich-chocolate', extra = {}) =>
  createPortrait({ width: 160, height: 210, tone, seed: 7, ...extra });

export const analysisFor = (frame) => new RegionResolver({ maskFeather: 4 }).analyse(frame);

export const engineContext = (frame, extra = {}) => {
  const resolver = new RegionResolver({ maskFeather: 4 });
  return {
    analysis: resolver.analyse(frame),
    resolver,
    core: { protectIdentity: 85, highlightSafety: 90, shadowSafety: 80, maskFeather: 4, maskExpand: 2 },
    renderStack,
    ...extra,
  };
};

export const frameDelta = (a, b) => {
  let max = 0;
  let sum = 0;
  let changed = 0;
  let clipped = 0;
  for (let i = 0; i < a.pixelCount; i++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(b.channels[c][i] - a.channels[c][i]);
      sum += d;
      if (d > max) max = d;
      if (d > 1) changed++;
    }
    if (b.r[i] >= 254.5 || b.r[i] <= 0.5) clipped++;
  }
  return {
    max,
    mean: sum / (a.pixelCount * 3),
    changedFraction: changed / (a.pixelCount * 3),
    clippedFraction: clipped / a.pixelCount,
  };
};

/** High-frequency energy (Laplacian magnitude) - the objective "texture" measure. */
export const textureEnergyOf = (frame, mask = null) => {
  const luma = lumaArray(frame);
  const { width, height } = frame;
  let sum = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mask && mask[i] < 0.5) continue;
      const lap = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width];
      sum += Math.abs(lap);
      n++;
    }
  }
  return n ? sum / n : 0;
};

export const localVariance = (frame, mask, radius = 6) => {
  const luma = lumaArray(frame);
  const { width, height } = frame;
  const values = [];
  for (let y = radius; y < height - radius; y += 2) {
    for (let x = radius; x < width - radius; x += 2) {
      const i = y * width + x;
      if (mask && mask[i] < 0.5) continue;
      let s = 0;
      let s2 = 0;
      let c = 0;
      for (let dy = -radius; dy <= radius; dy += 2) {
        for (let dx = -radius; dx <= radius; dx += 2) {
          const v = luma[(y + dy) * width + (x + dx)];
          s += v;
          s2 += v * v;
          c++;
        }
      }
      values.push(s2 / c - (s / c) ** 2);
    }
  }
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
};

export const meanLab = (frame, mask) => {
  let L = 0;
  let a = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i < frame.pixelCount; i++) {
    const m = mask ? mask[i] : 1;
    if (m < 0.5) continue;
    const lab = rgbToLab(frame.r[i], frame.g[i], frame.b[i]);
    L += lab.L * m;
    a += lab.a * m;
    b += lab.b * m;
    w += m;
  }
  return w ? { L: L / w, a: a / w, b: b / w } : { L: 0, a: 0, b: 0 };
};

export { TONE_PRESETS };
