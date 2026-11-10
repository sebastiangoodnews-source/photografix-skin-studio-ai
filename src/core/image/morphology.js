/**
 * Morphological + rank filters (erode, dilate, median) and edge-aware helpers.
 * Used by mask refinement, blemish detection and texture preservation.
 */

export const erode = (src, width, height, radius = 1) => {
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let m = Infinity;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= width) continue;
          const v = src[sy * width + sx];
          if (v < m) m = v;
        }
      }
      out[y * width + x] = m === Infinity ? src[y * width + x] : m;
    }
  }
  return out;
};

export const dilate = (src, width, height, radius = 1) => {
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let m = -Infinity;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= width) continue;
          const v = src[sy * width + sx];
          if (v > m) m = v;
        }
      }
      out[y * width + x] = m === -Infinity ? src[y * width + x] : m;
    }
  }
  return out;
};

/** Grey-scale morphological close (dilate then erode) - gap filling for masks. */
export const close = (src, width, height, radius = 1) => erode(dilate(src, width, height, radius), width, height, radius);

/** Grey-scale morphological open (erode then dilate) - speck removal. */
export const open = (src, width, height, radius = 1) => dilate(erode(src, width, height, radius), width, height, radius);

export const medianFilter = (src, width, height, radius = 1) => {
  const out = new Float32Array(src.length);
  const window = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      window.length = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= width) continue;
          window.push(src[sy * width + sx]);
        }
      }
      window.sort((a, b) => a - b);
      out[y * width + x] = window[window.length >> 1];
    }
  }
  return out;
};

/**
 * Anti-aliased threshold: produces a soft mask from a score image.
 */
export const softThreshold = (src, low, high) => {
  const out = new Float32Array(src.length);
  const span = Math.max(1e-6, high - low);
  for (let i = 0; i < src.length; i++) {
    const t = (src[i] - low) / span;
    const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
    out[i] = c * c * (3 - 2 * c);
  }
  return out;
};

/**
 * Edge-aware (guided) smoothing of a mask/noise field.
 * Keeps strong discontinuities while flattening noise inside regions.
 * `guide` must be same length as `src` (single channel, 0..255 or 0..1).
 */
export const guidedFilter = (src, guide, width, height, radius = 4, eps = 1e-3) => {
  const n = src.length;
  const meanI = boxMean(guide, width, height, radius);
  const meanP = boxMean(src, width, height, radius);
  const corrI = boxMean(sq(guide), width, height, radius);
  const corrIP = boxMean(mul(guide, src), width, height, radius);
  const varI = new Float32Array(n);
  const covIP = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    varI[i] = corrI[i] - meanI[i] * meanI[i];
    covIP[i] = corrIP[i] - meanI[i] * meanP[i];
  }
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const denom = varI[i] + eps;
    a[i] = denom <= 1e-9 ? 0 : covIP[i] / denom;
    b[i] = meanP[i] - a[i] * meanI[i];
  }
  const meanA = boxMean(a, width, height, radius);
  const meanB = boxMean(b, width, height, radius);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = meanA[i] * guide[i] + meanB[i];
  return out;
};

const sq = (arr) => {
  const o = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) o[i] = arr[i] * arr[i];
  return o;
};
const mul = (a, b) => {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] * b[i];
  return o;
};

export const boxMean = (src, width, height, radius) => {
  const r = Math.max(1, Math.round(radius));
  const out = new Float32Array(src.length);
  const tmp = new Float32Array(src.length);
  const denom = r * 2 + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + clampIdx(k, width)];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = acc / denom;
      acc += src[row + clampIdx(x + r + 1, width)] - src[row + clampIdx(x - r, width)];
    }
  }
  for (let x = 0; x < width; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[clampIdx(k, height) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = acc / denom;
      acc += tmp[clampIdx(y + r + 1, height) * width + x] - tmp[clampIdx(y - r, height) * width + x];
    }
  }
  return out;
};

const clampIdx = (v, n) => (v < 0 ? 0 : v >= n ? n - 1 : v);

/** Sobel gradient magnitude of a channel, normalised 0..1. */
export const gradientMagnitude = (src, width, height) => {
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xm = clampIdx(x - 1, width);
      const xp = clampIdx(x + 1, width);
      const ym = clampIdx(y - 1, height);
      const yp = clampIdx(y + 1, height);
      const gx =
        -src[ym * width + xm] - 2 * src[y * width + xm] - src[yp * width + xm] +
        src[ym * width + xp] + 2 * src[y * width + xp] + src[yp * width + xp];
      const gy =
        -src[ym * width + xm] - 2 * src[ym * width + x] - src[ym * width + xp] +
        src[yp * width + xm] + 2 * src[yp * width + x] + src[yp * width + xp];
      out[y * width + x] = Math.sqrt(gx * gx + gy * gy) / 1020;
    }
  }
  return out;
};

/**
 * Laplacian-based high-pass texture energy: how much fine detail a pixel carries.
 */
export const textureEnergy = (src, width, height) => {
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const xm = clampIdx(x - 1, width);
      const xp = clampIdx(x + 1, width);
      const ym = clampIdx(y - 1, height);
      const yp = clampIdx(y + 1, height);
      const c = src[y * width + x];
      const lap =
        4 * c - src[y * width + xm] - src[y * width + xp] - src[ym * width + x] - src[yp * width + x];
      out[y * width + x] = Math.abs(lap);
    }
  }
  return out;
};
