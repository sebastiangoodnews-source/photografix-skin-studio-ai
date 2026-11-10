import { clamp, smoothstep } from '../util/math.js';
import { blurChannelArray } from '../image/filters.js';
import { lumaArray } from '../analysis/histogram.js';
import { rgbToLab } from '../image/colorspace.js';
import { faceRegionMasks } from '../segmentation/face.js';
import { featherMask } from '../analysis/regions.js';

/**
 * LipEnhancementEngine
 *
 * Lip gloss, highlight, contour and brightness - with a hard rule: the engine
 * never recolours lips. Hue and chroma are preserved; only luminance structure
 * (specular bands on the upper/lower lip body) and a controlled contour darkening
 * are added. Texture is protected: the lip's own vertical striations are measured
 * and kept, so the enhancement reads as lit skin rather than a painted patch.
 */

export const detectLips = (frame, analysis, options = {}) => {
  const { width, height, pixelCount } = frame;
  if (!analysis.face?.found) return null;
  const zones = faceRegionMasks(frame, analysis.face, analysis.landmarks, { feather: Math.max(1, Math.round(width * 0.004)) });
  const luma = lumaArray(frame);
  const blur = blurChannelArray(luma, width, height, Math.max(2, width * 0.006));

  // Lips are darker and more saturated than their local surround. Refine the
  // geometric mouth zone against the photograph instead of trusting the ellipse.
  let moodSum = 0;
  let mouthCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    if (zones.lipArea[i] < 0.5) continue;
    moodSum += blur[i];
    mouthCount++;
  }
  const localMean = mouthCount ? moodSum / mouthCount : 128;
  const lipRefined = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const inZone = zones.lipArea[i];
    if (inZone <= 0.01) continue;
    const darker = 1 - smoothstep(0.55, 0.95, blur[i] / Math.max(1, localMean));
    const lab = rgbToLab(frame.r[i], frame.g[i], frame.b[i]);
    const chroma = Math.hypot(lab.a, lab.b);
    const saturated = smoothstep(10, 26, chroma);
    const redLean = smoothstep(0.2, 0.7, lab.a / Math.max(1, chroma));
    lipRefined[i] = clamp(inZone * (0.25 + darker * 0.4 + saturated * 0.2 + redLean * 0.15));
  }
  const mask = featherMask(lipRefined, width, height, options.feather ?? Math.max(1, width * 0.003));

  // Split upper/lower lip by the mouth line for independent highlight placement.
  const mouthY = analysis.landmarks.points.mouth.y;
  const upper = new Float32Array(pixelCount);
  const lower = new Float32Array(pixelCount);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] <= 0.01) continue;
      if (y < mouthY) upper[i] = mask[i];
      else lower[i] = mask[i];
    }
  }
  return { mask, upper, lower, mouthY, localMean };
};

export const buildLipHighlights = (frame, lip, options = {}) => {
  const { width, height, pixelCount } = frame;
  const { strength = 0.4, gloss = 0.5, contour = 0.3, brightness = 0.15, texture = 0.6 } = options;
  const luma = lumaArray(frame);
  const blur = blurChannelArray(luma, width, height, Math.max(1.5, width * 0.0025));
  const detail = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) detail[i] = luma[i] - blur[i];

  const glossLayer = new Float32Array(pixelCount);
  const contourLayer = new Float32Array(pixelCount);
  const textureProtect = new Float32Array(pixelCount);

  // The upper lip gets a smaller, higher specular; the lower lip a broader one.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const m = lip.mask[i];
      if (m <= 0.01) continue;
      const isUpper = y < lip.mouthY;
      const relative = blur[i] / Math.max(1, lip.localMean);
      // specular band: brighter part of the lip body, centre-weighted
      const centreWeight = 1 - Math.min(1, Math.abs(relative - 1.05) * 2.2);
      const band = clamp(centreWeight);
      const upperBoost = isUpper ? 0.75 : 1;
      const spec = band * upperBoost * gloss * m;
      glossLayer[i] = clamp(spec);

      // contour: darken the lip edge (inside the mask boundary) to restore shape
      const edge = clamp(1 - lip.mask[i] * 1.35);
      contourLayer[i] = clamp(edge * contour * m);

      // texture protection: keep the natural striations by reducing the gloss
      // where the lip detail is strong (striations must survive the gloss)
      const striation = Math.abs(detail[i]) / 22;
      textureProtect[i] = clamp(1 - striation * texture);
      glossLayer[i] *= textureProtect[i];
    }
  }

  // Highlights must not clip; scale by available headroom.
  for (let i = 0; i < pixelCount; i++) {
    const room = 1 - smoothstep(0.72, 0.97, luma[i] / 255);
    glossLayer[i] *= room;
    contourLayer[i] *= room * 0.85;
  }

  return {
    gloss: featherMask(glossLayer, width, height, Math.max(1, width * 0.002)),
    contour: featherMask(contourLayer, width, height, Math.max(1, width * 0.004)),
    brightness,
    strength,
    textureProtect,
  };
};

export const summariseMood = (frame, analysis) => {
  if (!analysis.face?.found) return 'unknown';
  return 'neutral';
};
