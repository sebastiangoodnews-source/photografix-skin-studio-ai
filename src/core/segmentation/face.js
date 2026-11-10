import { clamp } from '../util/math.js';
import { skinMask, skinProbabilityField } from '../analysis/skin.js';
import { largestHeadRegion, featherMask, headFromSilhouette, connectedComponents } from '../analysis/regions.js';
import { analyseExposure, lumaArray } from '../analysis/histogram.js';
import { textureEnergy, boxMean } from '../image/morphology.js';

/**
 * FaceSegmentationEngine
 *
 * Method: melanin-inclusive skin likelihood -> connected components -> largest
 * plausible head blob -> second-order moments (ellipse fit) -> anatomical landmark
 * prediction refined against the photograph's own luminance structure.
 *
 * This is a deterministic geometric prior, NOT a neural face-landmark model:
 * no model download, no API call, no paid credits, works offline inside UXP.
 * It is accurate for single-subject portraits and reports low confidence for
 * crowded or obscured scenes so callers can fall back to manual region selection.
 */

export const FACE_DETECTION_DEFAULTS = {
  minAreaRatio: 0.004,
  maxAreaRatio: 0.85,
  allowFallbackEllipse: true,
};

export const detectFace = (frame, options = {}) => {
  const { width, height } = frame;
  const opts = { ...FACE_DETECTION_DEFAULTS, ...options };
  const prob = skinProbabilityField(frame, { smoothRadius: 0.006 });
  const mask = skinMask(frame, { low: 0.3, high: 0.6, radius: 3 });
  const minArea = width * height * opts.minAreaRatio;
  const maxArea = width * height * opts.maxAreaRatio;

  // 1. Silhouette split: a portrait's skin is usually one blob (head + neck +
  //    body). The neck narrowing gives a far more reliable face boundary than raw
  //    connected-component moments, so try it first.
  const head = headFromSilhouette(mask, width, height, 0.45);
  if (head && head.area >= minArea && head.area <= maxArea) {
    const ellipse = ellipseFromHead(head);
    const { labels } = connectedComponents(head.mask, width, height, 0.45, 8);
    let bestLabel = -1;
    let bestArea = 0;
    for (const label of new Set(labels)) {
      if (label < 0) continue;
      let area = 0;
      for (let p = 0; p < labels.length; p++) if (labels[p] === label) area++;
      if (area > bestArea) {
        bestArea = area;
        bestLabel = label;
      }
    }
    const refinedMask = new Float32Array(width * height);
    for (let p = 0; p < refinedMask.length; p++) if (labels[p] === bestLabel) refinedMask[p] = 1;
    const feathered = featherMask(refinedMask, width, height, Math.max(1, Math.round(Math.min(width, height) * 0.006)));
    const aspect = head.aspect;
    const confidence = clamp(
      0.55 + (aspect >= 0.75 && aspect <= 1.85 ? 0.3 : 0.08) + clamp(head.area / (width * height * 0.12), 0, 1) * 0.12,
      0,
      1,
    );
    return {
      found: true,
      method: 'silhouette-neck-split',
      confidence,
      ellipse,
      bbox: head.bbox,
      mask: feathered,
      prob,
      metrics: { aspect, neckWidth: head.neckWidth, headHeight: head.bbox.height },
    };
  }

  // 2. Connected components: separate head blob in a crowded frame.
  const comp = largestHeadRegion(mask, width, height, 0.45);
  if (comp && comp.component.area >= minArea && comp.component.area <= maxArea) {
    const m = comp.moments || {};
    const ellipse = {
      cx: m.cx,
      cy: m.cy,
      rx: Math.max(6, m.rx || comp.component.bbox.width * 0.5),
      ry: Math.max(8, m.ry || comp.component.bbox.height * 0.5),
      angle: m.angle || 0,
    };
    const aspect = (ellipse.ry * 2) / Math.max(1, ellipse.rx * 2);
    const fill = comp.component.area / (Math.PI * ellipse.rx * ellipse.ry);
    const confidence = clamp(0.42 + (aspect >= 0.85 && aspect <= 1.9 ? 0.3 : 0.05) + clamp(fill, 0, 1.2) * 0.24, 0, 1);
    return {
      found: true,
      method: 'skin-moments',
      confidence,
      ellipse,
      bbox: comp.component.bbox,
      mask: comp.mask,
      prob,
      metrics: { aspect, fill },
    };
  }

  if (!opts.allowFallbackEllipse) {
    return { found: false, method: 'none', confidence: 0, prob, mask: null, ellipse: null };
  }

  // 3. Fallback: upper-centre portrait prior, flagged low confidence so the panel
  //    can offer manual region selection instead of pretending it found a face.
  const ellipse = {
    cx: width * 0.5,
    cy: height * 0.36,
    rx: width * 0.19,
    ry: height * 0.24,
    angle: 0,
  };
  return {
    found: true,
    method: 'portrait-prior',
    confidence: 0.28,
    ellipse,
    bbox: {
      minX: Math.round(ellipse.cx - ellipse.rx),
      minY: Math.round(ellipse.cy - ellipse.ry),
      maxX: Math.round(ellipse.cx + ellipse.rx),
      maxY: Math.round(ellipse.cy + ellipse.ry),
      width: Math.round(ellipse.rx * 2),
      height: Math.round(ellipse.ry * 2),
    },
    mask: ellipseMask(width, height, ellipse),
    prob,
    metrics: {},
  };
};

/** Fit a face ellipse to a silhouette head region (aspect-corrected). */
export const ellipseFromHead = (head) => {
  const { bbox } = head;
  const cx = (bbox.minX + bbox.maxX) / 2;
  // A head blob includes the neck stub; the face centre sits slightly above it.
  const cy = bbox.minY + bbox.height * 0.47;
  const rx = Math.max(6, (bbox.width / 2) * 0.94);
  const ry = Math.max(8, (bbox.height / 2) * 0.94);
  return { cx, cy, rx, ry: Math.max(ry, rx * 1.08), angle: 0 };
};

export const ellipseMask = (width, height, ellipse, featherPx = 3) => {
  const mask = new Float32Array(width * height);
  const cos = Math.cos(-ellipse.angle);
  const sin = Math.sin(-ellipse.angle);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - ellipse.cx;
      const dy = y - ellipse.cy;
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      const d = (lx * lx) / (ellipse.rx * ellipse.rx) + (ly * ly) / (ellipse.ry * ellipse.ry);
      if (d <= 1) mask[y * width + x] = 1;
    }
  }
  return featherMask(mask, width, height, featherPx);
};

/**
 * Anatomical landmark prediction inside a fitted face ellipse, refined with the
 * photograph's luminance field (eyes/mouth are darker, nose bridge/forehead catch
 * more light). Coordinates are document pixels.
 */
export const faceLandmarks = (frame, face) => {
  const e = face?.ellipse;
  if (!e) return null;
  const luma = lumaArray(frame);
  const { width, height } = frame;

  const at = (u, v) => {
    const lx = u * e.rx;
    const ly = v * e.ry;
    const cos = Math.cos(e.angle);
    const sin = Math.sin(e.angle);
    return { x: e.cx + lx * cos - ly * sin, y: e.cy + lx * sin + ly * cos };
  };

  /** Search a small window for the darkest / brightest sample. */
  const seek = (pt, radiusPx, mode) => {
    let best = null;
    let bestV = mode === 'min' ? Infinity : -Infinity;
    for (let dy = -radiusPx; dy <= radiusPx; dy += Math.max(1, Math.round(radiusPx / 5))) {
      for (let dx = -radiusPx; dx <= radiusPx; dx += Math.max(1, Math.round(radiusPx / 5))) {
        const x = Math.round(pt.x + dx);
        const y = Math.round(pt.y + dy);
        if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
        const local = boxMeanOf(luma, width, height, x, y);
        if (mode === 'min' ? local < bestV : local > bestV) {
          bestV = local;
          best = { x, y, luma: local };
        }
      }
    }
    return best || { x: pt.x, y: pt.y, luma: 128 };
  };

  const eyeR = Math.max(2, e.rx * 0.07);
  const leftEyePred = at(-0.4, -0.13);
  const rightEyePred = at(0.4, -0.13);
  const leftEye = seek(leftEyePred, Math.max(2, Math.round(e.rx * 0.12)), 'min');
  const rightEye = seek(rightEyePred, Math.max(2, Math.round(e.rx * 0.12)), 'min');
  const mouthPred = at(0, 0.45);
  const mouth = seek(mouthPred, Math.max(2, Math.round(e.rx * 0.1)), 'min');

  const interocular = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y) || 1;
  const faceWidth = e.rx * 2;

  return {
    confidence: face.confidence,
    interocular,
    faceWidth,
    faceHeight: e.ry * 2,
    rollDegrees: (e.angle * 180) / Math.PI,
    points: {
      forehead: at(0, -0.68),
      browCentre: at(0, -0.32),
      leftBrowBone: at(-0.42, -0.33),
      rightBrowBone: at(0.42, -0.33),
      glabella: at(0, -0.22),
      leftEye,
      rightEye,
      leftTemple: at(-0.86, -0.36),
      rightTemple: at(0.86, -0.36),
      noseBridgeUpper: at(0, -0.12),
      noseBridgeMid: at(0, 0.04),
      noseTip: at(0, 0.2),
      noseBase: at(0, 0.27),
      leftCheekbone: at(-0.63, 0.02),
      rightCheekbone: at(0.63, 0.02),
      leftCheek: at(-0.48, 0.22),
      rightCheek: at(0.48, 0.22),
      leftUnderCheek: at(-0.55, 0.42),
      rightUnderCheek: at(0.55, 0.42),
      leftUnderEye: at(-0.38, 0.02),
      rightUnderEye: at(0.38, 0.02),
      upperLip: { x: mouth.x, y: mouth.y - e.ry * 0.045 },
      lowerLip: { x: mouth.x, y: mouth.y + e.ry * 0.045 },
      mouth: { x: mouth.x, y: mouth.y },
      leftMouthCorner: at(-0.3, 0.46),
      rightMouthCorner: at(0.3, 0.46),
      chin: at(0, 0.78),
      leftJaw: at(-0.78, 0.42),
      rightJaw: at(0.78, 0.42),
      jawCentre: at(0, 0.62),
      leftEar: at(-1.0, 0.0),
      rightEar: at(1.0, 0.0),
    },
  };
};

const boxMeanOf = (arr, width, height, x, y) => {
  let sum = 0;
  let count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = clamp(y + dy, 0, height - 1);
    for (let dx = -1; dx <= 1; dx++) {
      const xx = clamp(x + dx, 0, width - 1);
      sum += arr[yy * width + xx];
      count++;
    }
  }
  return sum / count;
};

/**
 * Facial sub-region masks (0..1 Float32Array each), all clipped to the face skin
 * mask so no zone spills onto hair, background or clothing.
 */
export const faceRegionMasks = (frame, face, landmarks, options = {}) => {
  const { width, height } = frame;
  const e = face.ellipse;
  const lm = landmarks || faceLandmarks(frame, face);
  const skin = face.mask || ellipseMask(width, height, e, 2);
  const feather = options.feather ?? Math.max(2, Math.round(Math.min(width, height) * 0.012));

  const ellipseZone = (cx, cy, rx, ry) => {
    const m = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const d = dx * dx + dy * dy;
        if (d <= 1) m[y * width + x] = 1;
      }
    }
    return featherMask(m, width, height, feather);
  };

  const clip = (zone) => {
    for (let i = 0; i < zone.length; i++) zone[i] *= skin[i];
    return zone;
  };

  const p = lm.points;
  const rx = e.rx;
  const ry = e.ry;

  const zones = {
    forehead: clip(ellipseZone(e.cx, p.forehead.y, rx * 0.72, ry * 0.26)),
    nose: clip(ellipseZone((p.noseBridgeMid.x + p.noseTip.x) / 2, (p.noseBridgeMid.y + p.noseTip.y) / 2, rx * 0.16, ry * 0.28)),
    noseBridge: clip(ellipseZone(p.noseBridgeMid.x, p.noseBridgeMid.y, rx * 0.11, ry * 0.2)),
    cheeks: clip(
      combine([
        ellipseZone(p.leftCheek.x, p.leftCheek.y, rx * 0.28, ry * 0.2),
        ellipseZone(p.rightCheek.x, p.rightCheek.y, rx * 0.28, ry * 0.2),
      ]),
    ),
    cheekbones: clip(
      combine([
        ellipseZone(p.leftCheekbone.x, p.leftCheekbone.y, rx * 0.24, ry * 0.14),
        ellipseZone(p.rightCheekbone.x, p.rightCheekbone.y, rx * 0.24, ry * 0.14),
      ]),
    ),
    underEye: clip(
      combine([
        ellipseZone(p.leftUnderEye.x, p.leftUnderEye.y, rx * 0.2, ry * 0.1),
        ellipseZone(p.rightUnderEye.x, p.rightUnderEye.y, rx * 0.2, ry * 0.1),
      ]),
    ),
    chin: clip(ellipseZone(p.chin.x, p.chin.y - ry * 0.02, rx * 0.34, ry * 0.16)),
    jawline: jawlineMask(width, height, e, feather).map((v, i) => v * skin[i]),
    lips: clip(
      ellipseZone(p.mouth.x, p.mouth.y, rx * 0.3, ry * 0.075, false),
    ),
    lipArea: clip(ellipseZone(p.mouth.x, p.mouth.y, rx * 0.4, ry * 0.14)),
    temples: clip(
      combine([
        ellipseZone(p.leftTemple.x, p.leftTemple.y, rx * 0.16, ry * 0.16),
        ellipseZone(p.rightTemple.x, p.rightTemple.y, rx * 0.16, ry * 0.16),
      ]),
    ),
    browBones: clip(
      combine([
        ellipseZone(p.leftBrowBone.x, p.leftBrowBone.y, rx * 0.2, ry * 0.07),
        ellipseZone(p.rightBrowBone.x, p.rightBrowBone.y, rx * 0.2, ry * 0.07),
      ]),
    ),
    eyeSockets: clip(
      combine([
        ellipseZone(p.leftEye.x, p.leftEye.y, rx * 0.16, ry * 0.08),
        ellipseZone(p.rightEye.x, p.rightEye.y, rx * 0.16, ry * 0.08),
      ]),
    ),
  };
  zones.face = Float32Array.from(skin);
  return zones;
};

const combine = (zones) => {
  const out = Float32Array.from(zones[0]);
  for (let k = 1; k < zones.length; k++) {
    const z = zones[k];
    for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i], z[i]);
  }
  return out;
};

/** Ring following the jaw contour, used for jawline sculpting. */
const jawlineMask = (width, height, e, feather) => {
  const m = new Float32Array(width * height);
  const steps = 96;
  for (let s = 0; s <= steps; s++) {
    const t = Math.PI * 0.12 + (s / steps) * Math.PI * 0.76;
    const lx = Math.cos(t) * e.rx * 0.94;
    const ly = Math.sin(t) * e.ry * 0.94;
    const cos = Math.cos(e.angle);
    const sin = Math.sin(e.angle);
    const x = Math.round(e.cx + lx * cos - ly * sin);
    const y = Math.round(e.cy + ly * cos + lx * sin);
    stampDisc(m, width, height, x, y, Math.max(2, Math.round(Math.min(e.rx, e.ry) * 0.08)));
  }
  return featherMask(m, width, height, feather);
};

export const stampDisc = (mask, width, height, cx, cy, radius) => {
  const r2 = radius * radius;
  for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) mask[y * width + x] = 1;
    }
  }
};

/**
 * Quality/analysis report for the face: sharpness of texture, tonal range,
 * highlight/shadow distribution, suggested adaptive radius.
 */
export const analyseFaceSurface = (frame, face) => {
  const { width, height } = frame;
  const skin = face.mask;
  const luma = lumaArray(frame);
  let texSum = 0;
  let texCount = 0;
  let lSum = 0;
  let n = 0;
  const texture = textureEnergy(luma, width, height);
  for (let i = 0; i < frame.pixelCount; i++) {
    if (skin && skin[i] < 0.5) continue;
    texSum += texture[i];
    lSum += luma[i];
    n++;
    texCount++;
  }
  const meanTexture = n ? texSum / n : 0;
  const meanLuma = n ? lSum / n : 128;
  const exposure = analyseExposure(frame);
  // Texture-adaptive radius: clean smooth skin needs a smaller radius, grainy or
  // high-resolution skin benefits from a slightly larger one.
  const textureNorm = clamp(meanTexture / 26, 0, 1);
  const resScale = Math.max(width, height) / 2000;
  const suggestedRadius = clamp(6 + textureNorm * 10 + resScale * 3, 4, 24);
  const suggestedTextureRadius = clamp(suggestedRadius * 0.45, 2, 10);
  return {
    meanTexture,
    textureNorm,
    meanLuma,
    exposure,
    poreScale: clamp(Math.round(2 + resScale * 2), 2, 8),
    suggestedRadius: Math.round(suggestedRadius * 10) / 10,
    suggestedTextureRadius: Math.round(suggestedTextureRadius * 10) / 10,
    resolutionScale: resScale,
    sampleCount: n,
  };
};
