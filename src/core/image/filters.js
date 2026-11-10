import { gaussianKernel1D, clamp } from '../util/math.js';

/**
 * Separable gaussian blur with clamped edges.
 * Radius is expressed in pixels (sigma = radius / 2.6 to match the Photoshop
 * Gaussian Blur visual radius closely enough for frequency separation parity).
 */

export const radiusToSigma = (radius) => Math.max(0.35, radius / 2.6);

const blurChannel = (src, dst, width, height, kernel, kradius) => {
  const tmp = new Float32Array(src.length);
  // horizontal
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -kradius; k <= kradius; k++) {
        const sx = clamp(x + k, 0, width - 1);
        acc += src[row + sx] * kernel[k + kradius];
      }
      tmp[row + x] = acc;
    }
  }
  // vertical
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -kradius; k <= kradius; k++) {
        const sy = clamp(y + k, 0, height - 1);
        acc += tmp[sy * width + x] * kernel[k + kradius];
      }
      dst[y * width + x] = acc;
    }
  }
  return dst;
};

/** Blur a single Float32Array channel. */
export const blurChannelArray = (src, width, height, radius) => {
  const out = new Float32Array(src.length);
  if (radius <= 0.05) {
    out.set(src);
    return out;
  }
  const sigma = radiusToSigma(radius);
  const { kernel, radius: kr } = gaussianKernel1D(sigma);
  return blurChannel(src, out, width, height, kernel, kr);
};

/** Blur every RGB channel of a frame, returning a new frame. */
export const blurFrame = (frame, radius) => {
  const out = frame.clone();
  if (radius <= 0.05) return out;
  const sigma = radiusToSigma(radius);
  const { kernel, radius: kr } = gaussianKernel1D(sigma);
  for (let c = 0; c < 3; c++) {
    blurChannel(frame.channels[c], out.channels[c], frame.width, frame.height, kernel, kr);
  }
  return out;
};

/**
 * Approximate gaussian via three box passes - used for very large preview radii
 * where a true kernel would be O(r) per pixel.
 */
export const fastBlurChannelArray = (src, width, height, radius) => {
  if (radius <= 0.05) return Float32Array.from(src);
  const sigma = radiusToSigma(radius);
  const boxes = boxesForGauss(sigma, 3);
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  for (const box of boxes) {
    const r = Math.max(1, Math.floor((box - 1) / 2));
    boxBlurH(a, b, width, height, r);
    boxBlurV(b, a, width, height, r);
  }
  return a;
};

const boxesForGauss = (sigma, n) => {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
};

const boxBlurH = (src, dst, width, height, r) => {
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + clamp(k, 0, width - 1)];
    const denom = r * 2 + 1;
    for (let x = 0; x < width; x++) {
      dst[row + x] = acc / denom;
      acc += src[row + clamp(x + r + 1, 0, width - 1)] - src[row + clamp(x - r, 0, width - 1)];
    }
  }
};

const boxBlurV = (src, dst, width, height, r) => {
  for (let x = 0; x < width; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[clamp(k, 0, height - 1) * width + x];
    const denom = r * 2 + 1;
    for (let y = 0; y < height; y++) {
      dst[y * width + x] = acc / denom;
      acc += src[clamp(y + r + 1, 0, height - 1) * width + x] - src[clamp(y - r, 0, height - 1) * width + x];
    }
  }
};
