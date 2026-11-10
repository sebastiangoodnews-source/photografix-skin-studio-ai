import { clamp } from '../util/math.js';
import { skinMask } from '../analysis/skin.js';
import { featherMask } from '../analysis/regions.js';
import { stampDisc } from '../segmentation/face.js';
import { lumaArray } from '../analysis/histogram.js';
import { boxMean } from '../image/morphology.js';
import { ellipseMask } from './face.js';

/**
 * BodySegmentationEngine
 *
 * Deterministic anatomical banding of the exposed skin that is NOT the face.
 * Given a fitted face ellipse we know the subject's scale, so body zones are
 * expressed as multiples of face height (canonical portrait proportions rather
 * than fixed pixel offsets). Each zone is intersected with the skin likelihood
 * mask, which means clothing and background are excluded automatically.
 *
 * Not a human-parsing network: no models, no network access. For unusual framing
 * (extreme crops, multiple subjects) confidence drops and the panel offers a
 * manual/custom region path instead.
 */

export const BODY_ZONES = ['neck', 'chest', 'shoulders', 'collarbone', 'arms', 'waist', 'abdomen', 'legs', 'knees', 'calves'];

export const detectBody = (frame, face, options = {}) => {
  const { width, height } = frame;
  if (!face || !face.ellipse) {
    return { found: false, method: 'none', confidence: 0, zones: {}, skin: null };
  }
  const e = face.ellipse;
  const faceH = e.ry * 2;
  const skin = skinMask(frame, { low: 0.28, high: 0.62, radius: 3 });
  // Remove the face so body zones do not overlap facial treatment.
  const faceMask = face.mask || ellipseMask(width, height, e, 2);
  const bodySkin = new Float32Array(skin.length);
  let bodyPixels = 0;
  for (let i = 0; i < skin.length; i++) {
    const v = Math.max(0, skin[i] - faceMask[i]);
    bodySkin[i] = v;
    if (v > 0.5) bodyPixels++;
  }
  const coverage = bodyPixels / (width * height);

  const chinY = e.cy + e.ry;
  const shoulderY = chinY + faceH * 0.55;
  const chestBottomY = chinY + faceH * 1.35;
  const waistY = chinY + faceH * 2.05;
  const hipY = chinY + faceH * 2.6;
  const kneeY = chinY + faceH * 3.7;

  const feather = options.feather ?? Math.max(3, Math.round(Math.min(width, height) * 0.02));
  const bandMask = (y0, y1, x0, x1) => {
    const m = new Float32Array(width * height);
    const ya = Math.max(0, Math.round(y0));
    const yb = Math.min(height - 1, Math.round(y1));
    const xa = Math.max(0, Math.round(x0));
    const xb = Math.min(width - 1, Math.round(x1));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) m[y * width + x] = 1;
    }
    return m;
  };

  const bodyAxisX = estimateBodyAxis(bodySkin, width, height, chinY);
  const halfWidth = e.rx * 2.6;

  const zones = {};
  const addZone = (name, raw, extraScale = 1) => {
    const out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw[i] * bodySkin[i] * extraScale;
    zones[name] = featherMask(out, width, height, feather);
  };

  addZone('neck', bandMask(chinY - faceH * 0.04, shoulderY, bodyAxisX - e.rx * 0.85, bodyAxisX + e.rx * 0.85));
  addZone('chest', bandMask(shoulderY, chestBottomY, bodyAxisX - halfWidth, bodyAxisX + halfWidth));
  addZone('shoulders', bandMask(shoulderY - faceH * 0.18, shoulderY + faceH * 0.28, bodyAxisX - halfWidth, bodyAxisX + halfWidth));
  addZone('arms', bandMask(shoulderY + faceH * 0.2, hipY, bodyAxisX - halfWidth * 1.9, bodyAxisX + halfWidth * 1.9));
  // Arms should exclude the torso core: zero the centre column band.
  zeroBand(zones.arms, width, height, bodyAxisX - e.rx * 1.05, bodyAxisX + e.rx * 1.05);
  addZone('waist', bandMask(chestBottomY, waistY, bodyAxisX - halfWidth, bodyAxisX + halfWidth));
  addZone('abdomen', bandMask(chestBottomY + faceH * 0.2, hipY, bodyAxisX - e.rx * 1.2, bodyAxisX + e.rx * 1.2));
  addZone('legs', bandMask(hipY, height, 0, width));
  addZone('knees', bandMask(kneeY - faceH * 0.2, kneeY + faceH * 0.2, 0, width));
  addZone('calves', bandMask(kneeY + faceH * 0.2, Math.min(height, kneeY + faceH * 0.8), 0, width));

  zones.collarbone = collarboneMask(frame, bodyAxisX, shoulderY, faceH, bodySkin, feather);

  const zonesPresent = Object.entries(zones)
    .filter(([, m]) => massOf(m) > width * height * 0.0006)
    .map(([name]) => name);

  const confidence = clamp(0.3 + coverage * 1.4 + (zonesPresent.length / 10) * 0.4, 0, 1);

  return {
    found: zonesPresent.length > 0,
    method: 'anatomical-bands',
    confidence,
    coveragePct: coverage * 100,
    bodyAxisX,
    anchors: { chinY, shoulderY, chestBottomY, waistY, hipY, kneeY, faceHeight: faceH },
    zones,
    zonesPresent,
    skin: bodySkin,
  };
};

const estimateBodyAxis = (bodySkin, width, height, topY) => {
  let sum = 0;
  let weight = 0;
  for (let y = Math.max(0, Math.round(topY)); y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const v = bodySkin[y * width + x];
      if (v > 0.5) {
        sum += x;
        weight++;
      }
    }
  }
  return weight ? sum / weight : width / 2;
};

const zeroBand = (mask, width, height, x0, x1) => {
  const xa = Math.max(0, Math.round(x0));
  const xb = Math.min(width - 1, Math.round(x1));
  for (let y = 0; y < height; y++) {
    for (let x = xa; x <= xb; x++) mask[y * width + x] = 0;
  }
  return mask;
};

const massOf = (mask) => {
  let s = 0;
  for (let i = 0; i < mask.length; i++) s += mask[i];
  return s;
};

/**
 * Collarbone detection: a clavicle reads as a horizontal bright ridge pair just
 * below the neck, flanked by soft shadow. We build the mask from luminance ridges
 * so its position follows the actual anatomy/lighting of the shot.
 */
const collarboneMask = (frame, axisX, shoulderY, faceH, bodySkin, feather) => {
  const { width, height } = frame;
  const luma = lumaArray(frame);
  const mask = new Float32Array(width * height);
  const yTop = Math.max(0, Math.round(shoulderY + faceH * 0.02));
  const yBottom = Math.min(height - 1, Math.round(shoulderY + faceH * 0.35));
  const span = faceH * 2.3;
  let best = { y: yTop, score: -Infinity };
  for (let y = yTop; y <= yBottom; y++) {
    let score = 0;
    for (let x = Math.max(0, Math.round(axisX - span / 2)); x < Math.min(width, axisX + span / 2); x++) {
      const i = y * width + x;
      if (bodySkin[i] < 0.4) continue;
      const above = luma[Math.max(0, i - width)];
      const below = luma[Math.min(luma.length - 1, i + width)];
      score += luma[i] - (above + below) / 2;
    }
    if (score > best.score) best = { y, score };
  }
  for (let x = Math.max(0, Math.round(axisX - span / 2)); x < Math.min(width, axisX + span / 2); x++) {
    stampDisc(mask, width, height, x, best.y, Math.max(2, Math.round(faceH * 0.045)));
  }
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] * bodySkin[i];
  return featherMask(out, width, height, feather);
};

/**
 * Shoulder / arm outer contours: useful for sculpt and gloss so the highlight
 * follows the actual silhouette instead of a fixed ellipse.
 */
export const silhouetteContour = (bodySkin, width, height, rowStep = 4) => {
  const rows = [];
  for (let y = 0; y < height; y += rowStep) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < width; x++) {
      if (bodySkin[y * width + x] > 0.5) {
        if (left < 0) left = x;
        right = x;
      }
    }
    if (left >= 0) rows.push({ y, left, right, width: right - left + 1 });
  }
  return rows;
};
