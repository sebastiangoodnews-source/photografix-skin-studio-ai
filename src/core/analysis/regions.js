import { clamp } from '../util/math.js';
import { erode, dilate, boxMean } from '../image/morphology.js';

/**
 * Connected-component analysis used by the face and body segmenters to pick the
 * dominant skin region. Small, allocation-light, deterministic 4-neighbour flood fill.
 */
export const connectedComponents = (mask, width, height, threshold = 0.5, minPixels = 24) => {
  const n = width * height;
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const components = [];
  let next = 0;
  for (let start = 0; start < n; start++) {
    if (labels[start] !== -1 || mask[start] < threshold) continue;
    const label = next++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width;
      const y = (p - x) / width;
      area++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0) {
        const q = p - 1;
        if (labels[q] === -1 && mask[q] >= threshold) {
          labels[q] = label;
          stack[sp++] = q;
        }
      }
      if (x < width - 1) {
        const q = p + 1;
        if (labels[q] === -1 && mask[q] >= threshold) {
          labels[q] = label;
          stack[sp++] = q;
        }
      }
      if (y > 0) {
        const q = p - width;
        if (labels[q] === -1 && mask[q] >= threshold) {
          labels[q] = label;
          stack[sp++] = q;
        }
      }
      if (y < height - 1) {
        const q = p + width;
        if (labels[q] === -1 && mask[q] >= threshold) {
          labels[q] = label;
          stack[sp++] = q;
        }
      }
    }
    components.push({
      label,
      area,
      cx: sumX / area,
      cy: sumY / area,
      bbox: { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 },
    });
  }
  const kept = components.filter((c) => c.area >= minPixels).sort((a, b) => b.area - a.area);
  return { labels, components: kept };
};

/** Second-order moments of a labelled region -> centre, orientation and radii. */
export const regionMoments = (labels, label, width) => {
  const n = labels.length;
  let area = 0;
  let sx = 0;
  let sy = 0;
  for (let p = 0; p < n; p++) {
    if (labels[p] !== label) continue;
    const x = p % width;
    const y = (p - x) / width;
    area++;
    sx += x;
    sy += y;
  }
  if (!area) return null;
  const cx = sx / area;
  const cy = sy / area;
  let mu20 = 0;
  let mu02 = 0;
  let mu11 = 0;
  for (let p = 0; p < n; p++) {
    if (labels[p] !== label) continue;
    const x = p % width;
    const y = (p - x) / width;
    const dx = x - cx;
    const dy = y - cy;
    mu20 += dx * dx;
    mu02 += dy * dy;
    mu11 += dx * dy;
  }
  mu20 /= area;
  mu02 /= area;
  mu11 /= area;
  const common = Math.sqrt(Math.max(0, (mu20 - mu02) ** 2 + 4 * mu11 * mu11));
  const lambda1 = (mu20 + mu02 + common) / 2;
  const lambda2 = Math.max(1e-6, (mu20 + mu02 - common) / 2);
  const angle = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
  return {
    area,
    cx,
    cy,
    angle,
    // 2.2x sigma keeps the ellipse visually matched to a face blob
    rx: 2.2 * Math.sqrt(lambda1),
    ry: 2.2 * Math.sqrt(lambda2),
    sigmaMajor: Math.sqrt(lambda1),
    sigmaMinor: Math.sqrt(lambda2),
  };
};

/** Restrict a mask to the largest plausible "head" region. */
export const largestHeadRegion = (mask, width, height, threshold = 0.5) => {
  const { labels, components } = connectedComponents(mask, width, height, threshold);
  if (!components.length) return null;
  const maxArea = width * height * 0.92;
  const scored = components
    .filter((c) => c.area < maxArea)
    .map((c) => {
      const aspect = c.bbox.height / Math.max(1, c.bbox.width);
      const centred = 1 - Math.min(1, Math.abs(c.cx / width - 0.5) * 1.6);
      const upper = 1 - clamp(c.cy / height);
      const plausibility = clamp((aspect >= 0.68 && aspect <= 2.1 ? 1 : 0.25) * 0.45 + centred * 0.3 + upper * 0.25);
      return { ...c, score: c.area * plausibility };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  // A tiny or fully-covered image can leave nothing plausible; callers must be able
  // to fall back instead of crashing.
  if (!best) return null;
  const regionMask = new Float32Array(width * height);
  for (let p = 0; p < regionMask.length; p++) if (labels[p] === best.label) regionMask[p] = 1;
  return { mask: regionMask, component: best, moments: regionMoments(labels, best.label, width) };
};

/**
 * Silhouette-based head split.
 *
 * A whole-body skin mask is usually ONE connected component (face + neck + chest),
 * so connected-component moments alone mis-place the face. Portraits have a
 * reliable geometric signature: the skin silhouette narrows sharply at the neck.
 * We find that waist in the width profile and cut the head above it.
 *
 * Works for head-and-shoulders, waist-up and full-body crops; returns null when the
 * silhouette has no usable narrowing (callers then fall back to components).
 */
export const headFromSilhouette = (mask, width, height, threshold = 0.45) => {
  const rows = [];
  for (let y = 0; y < height; y++) {
    let left = -1;
    let right = -1;
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] >= threshold) {
        if (left < 0) left = x;
        right = x;
        count++;
      }
    }
    rows.push({ y, left, right, width: count });
  }
  const skinRows = rows.filter((r) => r.width > 2);
  if (skinRows.length < 8) return null;
  const top = skinRows[0].y;
  const bottom = skinRows[skinRows.length - 1].y;
  const span = bottom - top;
  if (span < 10) return null;

  // The neck is the narrowest skin row in the middle third-to-ninety-percent band.
  let neckRow = null;
  let neckWidth = Infinity;
  for (const r of skinRows) {
    if (r.y < top + span * 0.28 || r.y > top + span * 0.88) continue;
    if (r.width > 2 && r.width < neckWidth) {
      neckWidth = r.width;
      neckRow = r.y;
    }
  }
  const headBottom = neckRow ?? top + Math.round(span * 0.6);

  const headMask = new Float32Array(width * height);
  let minX = width;
  let maxX = 0;
  let count = 0;
  for (let y = top; y <= headBottom; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (mask[i] < threshold) continue;
      headMask[i] = mask[i];
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  if (!count) return null;
  const headHeight = headBottom - top + 1;
  const headWidth = maxX - minX + 1;
  // A face is taller than it is wide, but never absurdly so.
  const aspect = headHeight / Math.max(1, headWidth);
  if (aspect < 0.55 || aspect > 2.6) return null;
  return {
    mask: headMask,
    top,
    bottom: headBottom,
    neckRow: headBottom,
    bbox: { minX, minY: top, maxX, maxY: headBottom, width: headWidth, height: headHeight },
    neckWidth,
    area: count,
    aspect,
    rows: skinRows,
  };
};

/**
 * Feather a coverage mask.
 *
 * The blur is re-clipped to the original coverage, so the soft edge grows INWARD.
 * A plain blur would spread the mask a few pixels past the skin edge and paint a
 * halo onto hair and background - visible immediately on a portrait. `outward`
 * allows a deliberate 1-2px spill where a tool needs to bite into the edge.
 */
export const featherMask = (mask, width, height, radius, options = {}) => {
  if (radius <= 0.2) return mask;
  const { outward = 0 } = options;
  const r = Math.max(1, Math.round(radius));
  let out = boxMean(mask, width, height, r);
  out = boxMean(out, width, height, Math.max(1, Math.round(r * 0.6)));
  const clip = outward > 0 ? dilate(mask, width, height, Math.max(1, Math.round(outward))) : mask;
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.min(out[i], clip[i] <= 0 ? 0 : out[i]) * (clip[i] > 0 ? 1 : 0);
  }
  return out;
};

export const expandMask = (mask, width, height, pixels) => {
  if (!pixels) return mask;
  const r = Math.abs(Math.round(pixels));
  return pixels > 0 ? dilate(mask, width, height, r) : erode(mask, width, height, r);
};
