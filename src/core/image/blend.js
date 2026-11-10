import { clamp } from '../util/math.js';

/**
 * Blend modes implemented the way Photoshop's 8-bit blending behaves, so the
 * layer records we push into Photoshop reproduce the engine preview exactly.
 * All functions take base/top in 0..255 and return 0..255.
 */

const SCALE = 255;

export const normal = (b, t) => t;
export const multiply = (b, t) => (b * t) / SCALE;
export const screen = (b, t) => SCALE - ((SCALE - b) * (SCALE - t)) / SCALE;
export const linearDodge = (b, t) => clamp(b + t, 0, SCALE);
export const linearBurn = (b, t) => clamp(b + t - SCALE, 0, SCALE);
export const subtract = (b, t) => clamp(b - t, 0, SCALE);
export const difference = (b, t) => Math.abs(b - t);
export const exclusion = (b, t) => b + t - (2 * b * t) / SCALE;

export const overlay = (b, t) => {
  const bn = b / SCALE;
  const tn = t / SCALE;
  const v = bn <= 0.5 ? 2 * bn * tn : 1 - 2 * (1 - bn) * (1 - tn);
  return v * SCALE;
};

export const softLight = (b, t) => {
  const bn = b / SCALE;
  const tn = t / SCALE;
  let v;
  if (tn <= 0.5) v = bn - (1 - 2 * tn) * bn * (1 - bn);
  else {
    const d = bn <= 0.25 ? ((16 * bn - 12) * bn + 4) * bn : Math.sqrt(bn);
    v = bn + (2 * tn - 1) * (d - bn);
  }
  return v * SCALE;
};

export const hardLight = (b, t) => overlay(t, b);

/**
 * Linear Light: the blend Photoshop uses for a correctly built frequency
 * separation (linear dodge above the mid-point, linear burn below it).
 *
 * The neutral value is 127.5, not 128: with an 8-bit range of 0..255 the mid-point
 * is half of 255. Using 128 introduces a systematic +1 level lift on every
 * separation layer, which is exactly the kind of slow brightness creep that ruins a
 * multi-layer retouch. The engine emits its detail layers around 127.5 so this is
 * lossless; 8-bit quantisation happens only when pixels are written out.
 */
export const LINEAR_NEUTRAL = 127.5;
export const linearLight = (b, t) => clamp(b + 2 * (t - LINEAR_NEUTRAL), 0, SCALE);

export const colorDodge = (b, t) => (t >= SCALE ? SCALE : Math.min(SCALE, b / (1 - t / SCALE)));

export const colorBurn = (b, t) => {
  if (t <= 0) return 0;
  const v = SCALE - (SCALE - b) / (t / SCALE);
  return clamp(v, 0, SCALE);
};

export const darken = (b, t) => Math.min(b, t);
export const lighten = (b, t) => Math.max(b, t);

export const MODES = {
  normal,
  darken,
  lighten,
  multiply,
  screen,
  linearDodge,
  linearBurn,
  subtract,
  difference,
  exclusion,
  overlay,
  softLight,
  hardLight,
  linearLight,
  colorDodge,
  colorBurn,
};

/**
 * Record blend mode -> Photoshop batchPlay enum value.
 *
 * Photoshop spells most of these the way we do, but the arithmetic modes the
 * frequency-separation engines rely on have their own names ("linearDodge" is
 * Linear Dodge (Add), "linearLight" is Linear Light). Keeping the mapping here means
 * a layer can never silently land in Photoshop with the wrong mode - the audit in
 * the test suite walks this table against MODES.
 */
export const PHOTOSHOP_BLEND_NAMES = {
  normal: 'normal',
  passThrough: 'passThrough',
  multiply: 'multiply',
  screen: 'screen',
  linearDodge: 'linearDodge',
  linearBurn: 'linearBurn',
  subtract: 'subtract',
  difference: 'difference',
  exclusion: 'exclusion',
  overlay: 'overlay',
  softLight: 'softLight',
  hardLight: 'hardLight',
  linearLight: 'linearLight',
  colorDodge: 'colorDodge',
  colorBurn: 'colorBurn',
  darken: 'darken',
  lighten: 'lighten',
};

/** Blend a whole frame with a constant (used for tone tint layers). */
export const blendConstant = (frame, mode, colour, strength = 1) => {
  const fn = MODES[mode] || normal;
  const out = frame.clone();
  const [r, g, b] = out.channels;
  const s = clamp(strength);
  for (let i = 0; i < out.pixelCount; i++) {
    r[i] = r[i] + (fn(r[i], colour[0]) - r[i]) * s;
    g[i] = g[i] + (fn(g[i], colour[1]) - g[i]) * s;
    b[i] = b[i] + (fn(b[i], colour[2]) - b[i]) * s;
  }
  return out;
};

/**
 * Photoshop "Blend If" emulation for layer output: fades a layer out where the
 * underlying luminance falls outside a range. Needed so dodge/burn and glow
 * layers never crush blacks or clip highlights.
 */
export const blendIfMask = (baseLuma, blackLow = 0, blackHigh = 0, whiteLow = 255, whiteHigh = 255) => {
  const out = new Float32Array(baseLuma.length);
  for (let i = 0; i < baseLuma.length; i++) {
    const L = baseLuma[i];
    const lo = blackHigh === blackLow ? (L < blackLow ? 0 : 1) : clamp((L - blackLow) / (blackHigh - blackLow));
    const hi = whiteHigh === whiteLow ? (L > whiteHigh ? 0 : 1) : clamp((whiteHigh - L) / (whiteHigh - whiteLow));
    out[i] = Math.min(lo, hi);
  }
  return out;
};

/**
 * Inverse Soft Light: how far a Neutral-ish (128) layer must be pushed so that a
 * Soft Light composite raises the base by exactly `delta` levels.
 *
 * Glow and highlight tools express their intent in *levels of added light*
 * (anatomical and exposure-safe), and this converts that intent into the layer
 * values Photoshop will actually composite - which is what keeps the panel preview
 * and the committed layer stack identical.
 */
let softLightLUT = null;

const buildSoftLightLUT = () => {
  const lut = new Uint8Array(256 * 256);
  for (let base = 0; base < 256; base++) {
    for (let delta = 0; delta < 256; delta++) {
      if (delta === 0) {
        lut[base * 256] = 128;
        continue;
      }
      // monotone in d, so a binary search over the 1..127 offset is exact enough
      let lo = 1;
      let hi = 127;
      let found = 127;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const applied = softLight(base, 128 + mid) - base;
        if (applied >= delta) {
          found = mid;
          hi = mid - 1;
        } else lo = mid + 1;
      }
      lut[base * 256 + delta] = 128 + found;
    }
  }
  return lut;
};

export const softLightOffset = (base, delta) => {
  if (!softLightLUT) softLightLUT = buildSoftLightLUT();
  const b = Math.max(0, Math.min(255, Math.round(base)));
  const d = Math.max(0, Math.min(255, Math.round(delta)));
  return softLightLUT[b * 256 + d];
};

export const softLightOffsetNegative = (base, delta) => 256 - softLightOffset(255 - base, delta);
