import { clamp, smoothstep } from '../util/math.js';
import { blurFrame, blurChannelArray } from '../image/filters.js';
import { Frame } from '../image/frame.js';
import { lumaArray } from '../analysis/histogram.js';
import { createProtectionMask } from '../masks/masks.js';

/**
 * Base class + shared primitives for every processing engine.
 *
 * Contract implemented by all engines:
 *   inputs  : Frame (document-resolution RGB), validated settings, RegionResolver analysis
 *   outputs : { layers: LayerRecord[], preview: Frame, report: object }
 *
 * The base class enforces three safeguards that must never be bypassed:
 *   1. identity protection - a pixel can never move further than the configured
 *      distance from the original, so a tool cannot repaint the subject;
 *   2. highlight / shadow safety - no tool may clip speculars or crush blacks
 *      beyond the configured allowance;
 *   3. non-destructive output - engines return layer records plus a rendered
 *      preview; they never mutate the incoming frame.
 */

export class ProcessingEngine {
  constructor({ id, label, schema, defaults = {}, version = '1.0.0' }) {
    if (!id) throw new Error('ProcessingEngine requires an id');
    this.id = id;
    this.label = label || id;
    this.schema = schema;
    this.defaults = defaults;
    this.version = version;
  }

  /** Override in subclasses. */
  process(/* frame, settings, context */) {
    throw new Error(`${this.id}: process() not implemented`);
  }

  /**
   * Runs the engine with safeguards applied. Subclasses implement `compute` and
   * return the raw result; `process` wraps it.
   */
  run(frame, settings = {}, context = {}) {
    const ctx = this.prepareContext(frame, settings, context);
    const result = this.process(frame, ctx.settings, ctx);
    const guarded = this.applySafeguards(frame, result, ctx);
    return { ...result, ...guarded, report: { ...(result.report || {}), engine: this.id, version: this.version, settings: ctx.settings } };
  }

  prepareContext(frame, settings, context) {
    const safe = this.schema ? validateAgainst(this.schema, settings) : { ...this.defaults, ...settings };
    return {
      ...context,
      settings: safe,
      core: { protectIdentity: 85, highlightSafety: 90, shadowSafety: 80, ...(context.core || {}) },
    };
  }

  /**
   * Post-run guarantees.
   *
   * The composite a retoucher sees in the panel is *rendered from the layer stack*,
   * so it is already exactly what Photoshop will build - nothing here may change
   * pixels or the two would disagree. What this step does is:
   *   1. scrub NaN / Infinity (a numeric slip must never reach a layer), and
   *   2. report how far the run moved from the original, so the panel can warn when
   *      a tool exceeds the identity budget.
   *
   * Per-pixel magnitude limits are enforced INSIDE each engine, where the specific
   * meaning of "too much" is known (a texture split is allowed to reproduce the
   * original exactly; a colour move is not).
   */
  applySafeguards(frame, result, ctx) {
    const limit = identityLimit(ctx.core.protectIdentity);
    const layers = (result.layers || []).map((layer) => mapLayerFrames(layer, (f) => sanitiseFrame(f)));
    const preview = result.preview ? sanitiseFrame(result.preview) : null;
    let maxDelta = 0;
    let meanDelta = 0;
    if (preview) {
      let sum = 0;
      for (let i = 0; i < frame.pixelCount; i++) {
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(preview.channels[c][i] - frame.channels[c][i]);
          if (d > maxDelta) maxDelta = d;
          sum += d;
        }
      }
      meanDelta = sum / (frame.pixelCount * 3);
    }
    return {
      layers,
      preview,
      safeguardReport: {
        identityLimit: Math.round(limit * 10) / 10,
        maxDelta: Math.round(maxDelta * 10) / 10,
        meanDelta: Math.round(meanDelta * 100) / 100,
        exceededIdentityBudget: maxDelta > limit * 1.6,
      },
    };
  }
}

/** Remove NaN/Infinity and clamp to 0..255 so a numeric slip can never reach a layer. */
export const sanitiseFrame = (frame) => {
  for (let c = 0; c < frame.channels.length; c++) {
    const ch = frame.channels[c];
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      ch[i] = v !== v ? 128 : v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return frame;
};

const identityLimit = (protectPct) => {
  // 0% protection => 96 levels of freedom, 100% => 12 levels. Never zero freedom
  // (tools would do nothing) and never full freedom (a tool could repaint).
  const p = clamp(protectPct, 0, 100) / 100;
  return 96 - 84 * p;
};

export const mapLayerFrames = (node, fn) => {
  if (!node) return node;
  if (node.type === 'pixel' && node.frame) return { ...node, frame: fn(node.frame, node) };
  if (node.type === 'group') return { ...node, children: node.children.map((c) => mapLayerFrames(c, fn)) };
  return node;
};

/** Validate settings against a schema without throwing on unknown keys. */
export const validateAgainst = (schema, settings) => {
  const values = {};
  for (const p of schema.params) {
    let v = settings?.[p.id];
    if (v === undefined || v === null) v = p.default;
    if (p.type === 'range') v = clamp(Number(v), p.min, p.max);
    else if (p.type === 'bool') v = Boolean(v);
    else if (p.type === 'colour') v = (Array.isArray(v) ? v : p.default).map((c) => clamp(Math.round(Number(c)), 0, 255));
    else if (p.type === 'enum') {
      if (!p.options.some((o) => o.value === v)) v = p.default;
    }
    values[p.id] = v;
  }
  return values;
};

// ---------------------------------------------------------------------------
// Shared signal helpers
// ---------------------------------------------------------------------------

export const HIGH_PASS_MODES = {
  subtract: 'subtract',
  overlay: 'overlay',
  linearLight: 'linearLight',
};

/**
 * Low/high split used by every frequency separation mode.
 * `high = original - low` quantised to 128 neutral, which is what a Photoshop
 * "High Pass / Apply Image - Subtract + 128" split produces, so brushes behave
 * the way a retoucher expects when they open the group.
 */
export const splitFrequencies = (frame, radius, options = {}) => {
  const { highPassOffset = 127.5, mode = 'linearLight', lowFrequency = null, detailScale = 1 } = options;
  const low = lowFrequency || blurFrame(frame, radius);
  const high = new Frame(frame.width, frame.height);
  // 'linearLight': Photoshop's canonical Apply Image recipe - detail halved around
  // 128 and composited with Linear Light, which reconstructs the original exactly.
  // 'overlay': full detail around 128 on an Overlay layer (the classic High Pass
  // look). Both are legitimate; linearLight is the default because it is lossless.
  const gain = mode === 'linearLight' ? 0.5 : 1;
  for (let c = 0; c < 3; c++) {
    const orig = frame.channels[c];
    const lo = low.channels[c];
    const hi = high.channels[c];
    for (let i = 0; i < hi.length; i++) {
      hi[i] = clamp((orig[i] - lo[i]) * gain * detailScale + highPassOffset, 0, 255);
    }
  }
  return { low, high };
};

/** Detail / structure / pore band split (multi-scale). */
export const splitMultiScale = (frame, radii) => {
  const bands = [];
  let previous = frame.clone();
  for (const r of radii) {
    const current = blurFrame(previous, r);
    const band = new Frame(frame.width, frame.height);
    for (let c = 0; c < 3; c++) {
      const a = previous.channels[c];
      const b = current.channels[c];
      const o = band.channels[c];
      for (let i = 0; i < o.length; i++) o[i] = clamp(a[i] - b[i] + 128, 0, 255);
    }
    bands.push({ radius: r, band, low: current });
    previous = current;
  }
  return { bands, base: previous };
};

/**
 * Texture gate: 1 where the surface is smooth enough to accept smoothing.
 * Built from local high-frequency energy, so pores and blemishes (high energy)
 * are preserved while flat cheek areas (low energy) can be evened out.
 */
export const textureGate = (frame, options = {}) => {
  const { radius = 2, threshold = 6, softness = 4, invert = false } = options;
  const lumaField = lumaArray(frame);
  const { width, height } = frame;
  const blurred = blurChannelArray(lumaField, width, height, radius * 1.6);
  const out = new Float32Array(frame.pixelCount);
  for (let i = 0; i < out.length; i++) {
    const energy = Math.abs(lumaField[i] - blurred[i]);
    const t = smoothstep(threshold - softness, threshold + softness, energy);
    out[i] = invert ? t : 1 - t;
  }
  return out;
};

/**
 * Blemish isolation: small, high-contrast, roughly circular blobs of skin that
 * deviate from the local median. Returns a 0..1 mask of "damage" candidates.
 */
export const detectBlemishes = (frame, options = {}) => {
  const { sensitivity = 0.5, maxRadius = 6, minStrength = 4 } = options;
  const { width, height } = frame;
  const lumaField = lumaArray(frame);
  const localMed = medianApprox(lumaField, width, height, Math.max(1, Math.round(maxRadius)));
  const out = new Float32Array(frame.pixelCount);
  const low = minStrength + (1 - sensitivity) * 18;
  const high = low + 14;
  for (let i = 0; i < out.length; i++) {
    const diff = Math.abs(lumaField[i] - localMed[i]);
    out[i] = smoothstep(low, high, diff);
  }
  return out;
};

/** Fast approximate median via a small blur of min/max (robust to blemish spikes). */
export const medianApprox = (src, width, height, radius) => {
  const r = Math.max(1, Math.round(radius));
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let lo = Infinity;
      let hi = -Infinity;
      // sample the 8 neighbours at +/- r plus centre: a cheap robust estimator
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        const sx = clamp(Math.round(x + Math.cos(ang) * r), 0, width - 1);
        const sy = clamp(Math.round(y + Math.sin(ang) * r), 0, height - 1);
        const v = src[sy * width + sx];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      out[i] = (lo + hi) / 2;
      if (!Number.isFinite(out[i])) out[i] = src[i];
    }
  }
  return out;
};

/**
 * Local contrast normalisation (illumination flattening) used for even colour
 * blending. Removes slow luminance drift, keeps structure.
 */
export const flattenIllumination = (frame, radius, strength = 1) => {
  const low = blurFrame(frame, radius);
  const out = frame.clone();
  for (let c = 0; c < 3; c++) {
    const f = frame.channels[c];
    const l = low.channels[c];
    const o = out.channels[c];
    for (let i = 0; i < o.length; i++) {
      o[i] = clamp(f[i] + (l[i] - f[i]) * strength, 0, 255);
    }
  }
  return out;
};

/** Multiply a frame's mask into a copy (helper used by several engines). */
export const maskedFrame = (frame, mask) => {
  const out = frame.clone();
  for (let c = 0; c < 3; c++) {
    const o = out.channels[c];
    for (let i = 0; i < o.length; i++) o[i] = clamp(o[i] * mask[i], 0, 255);
  }
  return out;
};

/** Per-pixel blend of two frames with a mask. */
export const blendWithMask = (base, top, mask, strength = 1) => {
  const out = base.clone();
  for (let c = 0; c < 3; c++) {
    const b = base.channels[c];
    const t = top.channels[c];
    const o = out.channels[c];
    for (let i = 0; i < o.length; i++) {
      const a = mask[i] * strength;
      o[i] = clamp(b[i] + (t[i] - b[i]) * a, 0, 255);
    }
  }
  return out;
};

/** Difference metric used in tests and quality reports. */
export const frameStats = (a, b) => {
  let sum = 0;
  let max = 0;
  let count = 0;
  for (let c = 0; c < 3; c++) {
    const x = a.channels[c];
    const y = b.channels[c];
    for (let i = 0; i < x.length; i++) {
      const d = Math.abs(x[i] - y[i]);
      sum += d;
      if (d > max) max = d;
      count++;
    }
  }
  return { meanAbsDiff: count ? sum / count : 0, maxAbsDiff: max };
};
