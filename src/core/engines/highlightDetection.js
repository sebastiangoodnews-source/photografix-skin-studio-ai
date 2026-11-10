import { clamp, smoothstep } from '../util/math.js';
import { blurChannelArray, blurFrame } from '../image/filters.js';
import { lumaArray, estimateLightDirection } from '../analysis/histogram.js';
import { faceRegionMasks } from '../segmentation/face.js';
import { silhouetteContour } from '../segmentation/body.js';
import { unionMasks, intersectMasks, tonalMask, detailProtectionMask } from '../masks/masks.js';
import { featherMask } from '../analysis/regions.js';

/**
 * HighlightDetectionEngine
 *
 * Decides WHERE a glossy highlight belongs - and, more importantly, where it does
 * not. Two sources are combined:
 *
 *   A. Anatomy: candidate zones from the face landmarks / body silhouette
 *      (forehead, nose bridge, nose tip, upper cheekbones, cheek zones, brow bone,
 *      chin, lips, collarbone, shoulders, upper chest, arm and leg contours).
 *
 *   B. The photograph's own light: a zone only becomes a highlight if
 *        - it already faces the estimated key light,
 *        - it is on the lit side of the local luminance field,
 *        - it has headroom (not already clipped),
 *        - and it is skin (melanin-aware skin probability), not hair or clothing.
 *
 * The output is a set of per-area 0..1 masks plus a report of which ones scored
 * above threshold, so the panel can say "nose tip skipped: already specular"
 * instead of silently painting everywhere.
 */

export const HIGHLIGHT_AREAS = {
  face: [
    { id: 'forehead', label: 'Forehead highlight zone' },
    { id: 'noseBridge', label: 'Nose bridge' },
    { id: 'noseTip', label: 'Nose tip' },
    { id: 'cheekbones', label: 'Upper cheekbones' },
    { id: 'cheeks', label: 'Cheek highlight zones' },
    { id: 'browBones', label: 'Brow bone' },
    { id: 'chin', label: 'Chin highlight' },
    { id: 'lips', label: 'Lip highlights' },
  ],
  body: [
    { id: 'collarbone', label: 'Collarbone' },
    { id: 'shoulders', label: 'Shoulder highlights' },
    { id: 'chest', label: 'Upper chest' },
    { id: 'arms', label: 'Arm highlights' },
    { id: 'legs', label: 'Leg highlights' },
  ],
};

export const detectHighlights = (frame, analysis, options = {}) => {
  const {
    faceStrength = 1,
    bodyStrength = 1,
    includeFace = true,
    includeBody = true,
    spread = 0.5,
    luminanceGate = 0.35,
    seedZones = null,
  } = options;
  const { width, height, pixelCount } = frame;
  const light = estimateLightDirection(frame);
  const lumaField = lumaArray(frame);
  const skin = analysis.skin || new Float32Array(pixelCount).fill(1);
  const lumaSmooth = blurChannelArray(lumaField, width, height, Math.max(4, Math.min(width, height) * 0.03));
  // Exposure references. Deep skin is legitimately dark, so an absolute luma test
  // would reject every highlight on a dark subject. Each anatomical group is
  // therefore judged against its OWN median luminance: a face zone is "lit" when it
  // is brighter than the face, not when it is brighter than a white wall. Absolute
  // values are used only to guard against clipping.
  const faceRef = skinMedianLuma(lumaField, analysis.regions?.face || null, pixelCount);
  const bodyRef = skinMedianLuma(
    lumaField,
    analysis.body?.skin || analysis.skin || null,
    pixelCount,
  );
  const localMax = Math.max(...sampleEvery(lumaSmooth, 97), 1);
  const features = detailProtectionMask(frame, { threshold: 0.14, softness: 0.06, radius: 2 });

  const areas = {};
  const skipped = [];
  const scored = [];

  const zoneScore = (zone, label, ref) => {
    if (!zone) return null;
    let sum = 0;
    let weight = 0;
    let headroom = 0;
    let litSide = 0;
    let skinScore = 0;
    for (let i = 0; i < pixelCount; i += 3) {
      const z = zone[i];
      if (z <= 0.2) continue;
      const L = lumaField[i] / 255;
      const room = 1 - smoothstep(0.78, 0.985, L);
      // lit = brighter than the skin's own median (melanin-independent)
      const relative = lumaSmooth[i] / Math.max(6, ref);
      const isLit = smoothstep(0.8, 1.12, relative);
      sum += z * (room * 0.55 + isLit * 0.45) * (1 - (1 - features[i]) * 0.5);
      headroom += z * room;
      litSide += z * isLit;
      skinScore += z * (skin ? skin[i] : 1);
      weight += z;
    }
    if (weight <= 0.0001) {
      skipped.push({ id: label, reason: 'no coverage' });
      return null;
    }
    const score = sum / weight;
    const metrics = { headroom: headroom / weight, lit: litSide / weight, skin: skinScore / weight, coverage: weight / pixelCount };
    if (metrics.coverage < 0.0004) {
      skipped.push({ id: label, reason: 'too small' });
      return null;
    }
    if (metrics.headroom < 0.12) {
      skipped.push({ id: label, reason: 'already specular' });
      return null;
    }
    if (metrics.lit < 0.18) {
      // Deep in shadow relative to its own group: painting a highlight here would
      // contradict the photograph's lighting.
      skipped.push({ id: label, reason: 'in shadow' });
      return null;
    }
    if (metrics.skin < 0.35) {
      skipped.push({ id: label, reason: 'not skin' });
      return null;
    }
    scored.push({ id: label, score, metrics });
    return { score, metrics };
  };

  const spreadRadius = Math.max(1.5, spread * 12);

  const register = (id, zone, label, strength, ref = faceRef) => {
    if (!zone) return;
    const res = zoneScore(zone, label, ref);
    if (!res) return;
    let mask = new Float32Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      const L = lumaField[i] / 255;
      const room = 1 - smoothstep(0.8, 0.99, L);
      // locally lit pixels get proportionally more light than shadowed ones
      const relative = lumaSmooth[i] / Math.max(6, ref);
      const litWeight = 0.35 + smoothstep(0.78, 1.1, relative) * 0.65;
      // The score qualified the area (it decided whether we got here); it must not
      // scale the light down to nothing. Quality factor stays within 0.55..1.
      const quality = 0.55 + clamp(res.score) * 0.45;
      mask[i] = clamp(zone[i] * room * litWeight * (1 - (1 - features[i]) * 0.6) * quality * strength);
    }
    if (spreadRadius > 0) mask = featherMask(mask, width, height, spreadRadius);
    // Normalise after spreading: the shape is preserved and the strongest point of
    // the zone is fully paintable. Global intensity decides how much light is added.
    let peak = 0;
    for (let i = 0; i < pixelCount; i++) if (mask[i] > peak) peak = mask[i];
    if (peak > 0.001) {
      const inv = 1 / peak;
      for (let i = 0; i < pixelCount; i++) mask[i] = clamp(mask[i] * inv);
    }
    areas[id] = {
      id,
      label,
      zone: mask,
      score: res.score,
      metrics: { ...res.metrics, peak },
    };
  };

  if (includeFace && analysis.face?.found) {
    const zones = seedZones?.face || faceRegionMasks(frame, analysis.face, analysis.landmarks, {
      feather: Math.max(2, Math.round(Math.min(width, height) * 0.008)),
    });
    register('forehead', zones.forehead, 'forehead', faceStrength);
    register('noseBridge', zones.noseBridge, 'nose bridge', faceStrength);
    register('noseTip', shrinkZone(zones.nose, width, 0.45), 'nose tip', faceStrength);
    register('cheekbones', zones.cheekbones, 'cheekbones', faceStrength);
    register('cheeks', zones.cheeks, 'cheeks', faceStrength);
    register('browBones', zones.browBones, 'brow bone', faceStrength * 0.85);
    register('chin', zones.chin, 'chin', faceStrength);
    register('lips', zones.lips, 'lips', faceStrength * 0.7);
  }

  if (includeBody && analysis.body?.found) {
    const z = analysis.body.zones || {};
    register('collarbone', z.collarbone, 'collarbone', bodyStrength, bodyRef);
    register('chest', z.chest, 'upper chest', bodyStrength, bodyRef);
    register('shoulders', z.shoulders, 'shoulders', bodyStrength, bodyRef);
    register('arms', z.arms, 'arms', bodyStrength * 0.9, bodyRef);
    register('legs', z.legs, 'legs', bodyStrength * 0.85, bodyRef);
    // Shoulder/arm highlights are refined to the lit contour, not the whole limb.
    if (analysis.contour && (areas.shoulders || areas.arms)) {
      const contourLit = contourHighlightMask(frame, analysis, light, lumaField, width, height, bodyStrength);
      areas.contour = { id: 'contour', label: 'body contour', zone: contourLit, score: 0.6, metrics: { coverage: coverageOf(contourLit) } };
    }
  }

  const all = Object.values(areas);
  const combined = all.length ? unionMasks(all.map((a) => a.zone)) : new Float32Array(pixelCount);

  return {
    areas,
    combined,
    light,
    scored,
    skipped,
    summary: {
      areasFound: all.length,
      areasSkipped: skipped.length,
      lightSource: light.source,
      lightConfidence: light.confidence,
      averageScore: all.length ? all.reduce((a, b) => a + b.score, 0) / all.length : 0,
      faceReferenceLuma: faceRef,
      bodyReferenceLuma: bodyRef,
    },
  };
};

const shrinkZone = (zone, width, factor) => {
  if (!zone) return null;
  // keep the strongest core of a zone (used for nose tip: the tip, not the alae)
  const out = new Float32Array(zone.length);
  for (let i = 0; i < out.length; i++) out[i] = zone[i] > 0.75 ? zone[i] * factor + 0.25 : zone[i] * factor * 0.4;
  return out;
};

const contourHighlightMask = (frame, analysis, light, lumaField, width, height, strength) => {
  const { pixelCount } = frame;
  const mask = new Float32Array(pixelCount);
  const unit = analysis.body.anchors.faceHeight;
  const contour = analysis.contour || [];
  const axis = analysis.body.bodyAxisX;
  for (const row of contour) {
    const leftToRight = light.x >= 0;
    const x = leftToRight ? row.right - unit * 0.07 : row.left + unit * 0.07;
    const y = row.y;
    const radius = Math.max(2, Math.round(unit * 0.05));
    stampRow(mask, width, height, x, y, radius, strength);
  }
  return featherMask(mask, width, height, Math.max(2, unit * 0.04));
};

const stampRow = (mask, width, height, cx, cy, radius, weight) => {
  for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
      const d = Math.hypot(x - cx, y - cy) / radius;
      if (d > 1) continue;
      const v = weight * (1 - d) * (1 - d);
      const i = y * width + x;
      if (v > mask[i]) mask[i] = v;
    }
  }
};

/** Median luminance of the skin itself - the exposure reference for "lit". */
export const skinMedianLuma = (lumaField, skin, pixelCount) => {
  const samples = [];
  const stride = Math.max(1, Math.floor(pixelCount / 4000));
  for (let i = 0; i < pixelCount; i += stride) {
    if (!skin || skin[i] > 0.5) samples.push(lumaField[i]);
  }
  if (!samples.length) return 96;
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
};

const sampleEvery = (arr, step) => {
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  return out;
};

const coverageOf = (m) => {
  let s = 0;
  for (let i = 0; i < m.length; i++) s += m[i];
  return m.length ? s / m.length : 0;
};
