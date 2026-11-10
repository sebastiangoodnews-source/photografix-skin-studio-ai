import { clamp, smoothstep, luma } from '../util/math.js';
import { erode, dilate, boxMean, gradientMagnitude, guidedFilter, softThreshold } from '../image/morphology.js';
import { featherMask, expandMask } from '../analysis/regions.js';
import { lumaArray } from '../analysis/histogram.js';

/**
 * MaskManagementEngine
 *
 * Every tool composes its coverage from these primitives, so mask behaviour
 * (feather, expand/contract, weighting) is consistent across the suite and the
 * same numbers are handed to Photoshop as a real layer mask - the panel preview
 * and the layer mask are generated from one code path.
 *
 * Masks are Float32Array fields, 0..1, one value per pixel.
 */

export const emptyMask = (n) => new Float32Array(n);
export const fullMask = (n) => new Float32Array(n).fill(1);

export const unionMasks = (masks) => {
  const out = new Float32Array(masks[0].length);
  for (const m of masks) {
    for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i], m[i]);
  }
  return out;
};

export const intersectMasks = (masks) => {
  const out = Float32Array.from(masks[0]);
  for (let k = 1; k < masks.length; k++) {
    const m = masks[k];
    for (let i = 0; i < out.length; i++) out[i] *= m[i];
  }
  return out;
};

export const scaleMask = (mask, s) => {
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = clamp(mask[i] * s);
  return out;
};

export const invertMask = (mask) => {
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = 1 - mask[i];
  return out;
};

export const addMasks = (a, b, weightA = 1, weightB = 1) => {
  const out = new Float32Array(a.length);
  for (let i = 0; i < out.length; i++) out[i] = clamp(a[i] * weightA + b[i] * weightB);
  return out;
};

/**
 * Refine a coverage mask: smooth, feather, expand/contract, remove specks.
 * `strength` 0..1 controls how much refinement is applied.
 */
export const refineMask = (mask, width, height, options = {}) => {
  const {
    feather = 4,
    expand = 0,
    smooth = 1,
    speckleRadius = 1,
    strength = 1,
  } = options;
  if (strength <= 0) return Float32Array.from(mask);
  let m = Float32Array.from(mask);
  const s = clamp(strength);
  if (speckleRadius > 0) {
    // remove islands then re-grow: equivalent to open+close, keeps edges in place
    const opened = dilate(erode(m, width, height, speckleRadius), width, height, speckleRadius);
    const closed = erode(dilate(opened, width, height, speckleRadius), width, height, speckleRadius);
    for (let i = 0; i < m.length; i++) m[i] = m[i] * (1 - s) + closed[i] * s;
  }
  if (expand !== 0) m = expandMask(m, width, height, expand);
  if (feather > 0 && smooth > 0) m = featherMask(m, width, height, feather * smooth);
  return m;
};

/** Soft-edged rectangle (custom selection). */
export const rectMask = (width, height, rect, feather = 6) => {
  const m = new Float32Array(width * height);
  const x0 = clamp(Math.round(rect.x), 0, width - 1);
  const y0 = clamp(Math.round(rect.y), 0, height - 1);
  const x1 = clamp(Math.round(rect.x + rect.width), 0, width - 1);
  const y1 = clamp(Math.round(rect.y + rect.height), 0, height - 1);
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) m[y * width + x] = 1;
  }
  return featherMask(m, width, height, feather);
};

/** Soft-edged circular brush dab (for painted masks from the panel). */
export const dabMask = (width, height, points, radius, options = {}) => {
  const { softness = 0.6, flow = 1 } = options;
  const m = new Float32Array(width * height);
  const inner = radius * (1 - clamp(softness));
  for (const pt of points) {
    const x0 = Math.max(0, Math.floor(pt.x - radius));
    const x1 = Math.min(width - 1, Math.ceil(pt.x + radius));
    const y0 = Math.max(0, Math.floor(pt.y - radius));
    const y1 = Math.min(height - 1, Math.ceil(pt.y + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - pt.x, y - pt.y);
        if (d > radius) continue;
        const a = d <= inner ? 1 : 1 - smoothstep(inner, radius, d);
        const i = y * width + x;
        m[i] = clamp(m[i] + a * flow * (1 - m[i]));
      }
    }
  }
  return m;
};

/**
 * Luminance-based selection mask (shadows / midtones / highlights), matching the
 * Photoshop colour-range semantics the dodge & burn layers rely on.
 */
export const tonalMask = (frame, band, options = {}) => {
  const { softness = 0.25, preserveClipping = true } = options;
  const lumaField = lumaArray(frame);
  const n = frame.pixelCount;
  const out = new Float32Array(n);
  const s = clamp(softness, 0.01, 1);
  for (let i = 0; i < n; i++) {
    const L = lumaField[i] / 255;
    let v;
    if (band === 'shadows') v = 1 - smoothstep(0.18 + s * 0.25, 0.55, L);
    else if (band === 'highlights') v = smoothstep(0.45, 0.82 - s * 0.25, L);
    else if (band === 'midtones') v = Math.exp(-Math.pow((L - 0.5) / (0.22 + s * 0.3), 2));
    else v = 1;
    if (preserveClipping) {
      // never push pure black or pure white further
      if (band === 'shadows') v *= 1 - smoothstep(0.06, 0, L);
      if (band === 'highlights') v *= 1 - smoothstep(0.994, 1, L);
    }
    out[i] = clamp(v);
  }
  return out;
};

/**
 * Highlight/shadow protection mask from the original: 0 where the pixel is at a
 * tonal extreme, 1 where there is headroom. Prevents highlight clipping and
 * shadow crushing for every additive tool.
 */
export const createProtectionMask = (frame, options = {}) => {
  const { highlightSafety = 0.9, shadowSafety = 0.8 } = options;
  const lumaField = lumaArray(frame);
  const n = frame.pixelCount;
  const out = new Float32Array(n);
  // 1.0 = a free pixel (room to move), 0.0 = at an extreme (do not touch).
  // highlightSafety/shadowsSafety widen the protected band as they approach 1.
  const hiBand = 18 + 52 * clamp(highlightSafety);
  const loBand = 10 + 42 * clamp(shadowSafety);
  for (let i = 0; i < n; i++) {
    const L = lumaField[i];
    const hi = 1 - smoothstep(255 - hiBand, 255, L);
    const lo = smoothstep(0, loBand, L);
    out[i] = clamp(Math.min(hi, lo));
  }
  return out;
};

/**
 * Detail/feature protection mask: 1.0 on skin, falling to 0.0 across structure
 * edges (eyes, lashes, lips, nostrils, hair strands).
 *
 * Callers multiply by it to keep auto-smoothing away from features - always as
 * `* featureProtection[i]`, i.e. 1 = untouched. (An earlier revision inverted this
 * and suppressed exactly the flat areas retouching is meant to affect.)
 */
export const detailProtectionMask = (frame, options = {}) => {
  const { threshold = 0.12, softness = 0.06, radius = 2 } = options;
  const lumaField = lumaArray(frame);
  const norm = new Float32Array(lumaField.length);
  for (let i = 0; i < lumaField.length; i++) norm[i] = lumaField[i] / 255;
  const grad = gradientMagnitude(norm, frame.width, frame.height);
  const m = new Float32Array(grad.length);
  for (let i = 0; i < grad.length; i++) {
    m[i] = 1 - smoothstep(threshold - softness, threshold + softness, grad[i]);
  }
  return radius > 0 ? boxMean(m, frame.width, frame.height, radius) : m;
};

/** 1.0 on structure edges, 0.0 on skin - the complement of detailProtectionMask. */
export const featureEdgeMask = (frame, options = {}) => {
  const protect = detailProtectionMask(frame, options);
  const out = new Float32Array(protect.length);
  for (let i = 0; i < out.length; i++) out[i] = 1 - protect[i];
  return out;
};

/**
 * Guided (edge-aware) mask cleanup using the photograph as guide, so masks hug
 * real skin boundaries instead of geometric ones.
 */
export const edgeAwareRefine = (mask, frame, radius = 4, eps = 0.002) => {
  const lumaField = lumaArray(frame);
  const guide = new Float32Array(lumaField.length);
  for (let i = 0; i < guide.length; i++) guide[i] = lumaField[i] / 255;
  return guidedFilter(mask, guide, frame.width, frame.height, radius, eps);
};

/** Convert a mask to 8-bit greyscale RGBA for the Photoshop layer mask channel. */
export const maskToRGBA = (mask) => {
  const n = mask.length;
  const buf = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = clamp(Math.round(mask[i] * 255), 0, 255);
    buf[j] = v;
    buf[j + 1] = v;
    buf[j + 2] = v;
    buf[j + 3] = 255;
  }
  return buf;
};

/** Approximate a selection into a polygon for Photoshop selection APIs (safety net). */
export const maskToPolygon = (mask, width, height, threshold = 0.5) => {
  const pts = [];
  for (let y = 0; y < height; y += 3) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] >= threshold) {
        if (left < 0) left = x;
        right = x;
      }
    }
    if (left >= 0) {
      pts.push({ x: left, y });
      pts.push({ x: right, y });
    }
  }
  return pts;
};

export const maskCoverage = (mask) => {
  let s = 0;
  for (let i = 0; i < mask.length; i++) s += mask[i];
  return mask.length ? s / mask.length : 0;
};

export { softThreshold };
