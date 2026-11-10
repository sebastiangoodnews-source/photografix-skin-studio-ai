import { clamp, luma } from '../util/math.js';
import { defineSchema } from '../util/params.js';
import { Frame } from '../image/frame.js';
import { blurFrame, blurChannelArray } from '../image/filters.js';
import { lumaArray, computeHistogram, percentileFromHistogram, estimateSharpness } from '../analysis/histogram.js';
import { rgbToLab, labToRgb } from '../image/colorspace.js';
import { summariseSkin } from '../analysis/skin.js';
import {
  emptyMask,
  fullMask,
  intersectMasks,
  scaleMask,
  refineMask,
  detailProtectionMask,
  maskCoverage,
} from '../masks/masks.js';
import { group, pixelLayer, adjustmentLayer } from '../layers/record.js';
import { ProcessingEngine } from './common.js';

/**
 * FinalReviewEngine - stage 7.
 *
 * Everything before this stage *makes* pixels. This engine *inspects* them and
 * gives the retoucher the last, cheapest controls: where to keep or dial back the
 * work, whether the skin survived, and how the image reads next to the original.
 * It is deliberately additive-only:
 *
 *   - it never re-renders the retouch, so it cannot undo a previous stage;
 *   - it only ever emits a masked, low-opacity refinement plus a diagnostics group;
 *   - every recommendation it prints is computed from the pixels in front of it,
 *     using the same region analysis the earlier stages used, so advice and masks
 *     always agree.
 *
 * The checks that matter on African and melanin-rich skin are first-class here,
 * not an afterthought: melanin drift, plastic-skin texture loss, halo/dark rim
 * artefacts along the face edge, shadow crushing and highlight clipping, and
 * whether the face still matches the chest.
 */

export const REVIEW_ANALYSIS_SCHEMA = defineSchema([
  {
    id: 'region',
    type: 'enum',
    label: 'Review region',
    group: 'Review',
    options: [
      { value: 'face', label: 'Face' },
      { value: 'fullBody', label: 'Full body' },
      { value: 'neck', label: 'Neck' },
      { value: 'chest', label: 'Chest' },
      { value: 'custom', label: 'Custom selection' },
    ],
    default: 'fullBody',
    help: 'Where the artefact scan and the safety check look. Body zones are included so a mask cannot hide a problem on the chest or arms.',
  },
  { id: 'textureThreshold', type: 'range', min: 5, max: 80, step: 1, unit: '%', label: 'Texture-loss alarm', group: 'Alerts', default: 38, help: 'Warn when the retouch removed more texture than this. Above roughly 55% skin starts to read plastic.' },
  { id: 'haloThreshold', type: 'range', min: 2, max: 40, step: 1, label: 'Halo alarm', group: 'Alerts', default: 8, help: 'Edge brightness difference, in levels, that counts as a halo along the face or body edge.' },
  { id: 'melaninTolerance', type: 'range', min: 1, max: 20, step: 0.5, label: 'Melanin drift allowance', group: 'Alerts', default: 4, unit: 'L*', help: 'How much the median skin lightness may move before the review flags a brightness change. Deep skin should stay close to this.' },
  { id: 'falseColour', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'False-colour strength', group: 'Tools', default: 0, help: 'Judgement view: shows how evenly the tone is distributed. This layer starts hidden and only ever helps the eye.' },
]);

export const FINAL_REVIEW_SCHEMA = defineSchema([
  ...REVIEW_ANALYSIS_SCHEMA.params,
  {
    id: 'refineRemaining',
    type: 'bool',
    label: 'Refine remaining blemishes',
    group: 'Finish',
    default: false,
    help: 'One last, very restrained pass over texture that every previous stage left behind. Uses the same protect-first masks as stage 1, so it cannot smear pores.',
  },
  { id: 'refineStrength', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Refine strength', group: 'Finish', default: 22, visibleWhen: { id: 'refineRemaining', equals: true } },
  { id: 'refineRadius', type: 'range', min: 2, max: 24, step: 0.5, unit: 'px', label: 'Refine radius', group: 'Finish', default: 5, visibleWhen: { id: 'refineRemaining', equals: true } },
  {
    id: 'evenSkin',
    type: 'bool',
    label: 'Even remaining skin tone',
    group: 'Finish',
    default: false,
    help: 'Corrects slow colour drift only - never luminance - so complexion is even without lightening the skin.',
  },
  { id: 'evenStrength', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Even strength', group: 'Finish', default: 30, visibleWhen: { id: 'evenSkin', equals: true } },
  {
    id: 'matching',
    type: 'enum',
    label: 'Face/body matching',
    group: 'Finish',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'neck', label: 'Match face to neck' },
      { value: 'body', label: 'Match face to body' },
      { value: 'both', label: 'Match both' },
    ],
    default: 'off',
    help: 'Brings the face back into the same colour family as the neck and chest. Usually the last thing a make-up or flash mismatch needs.',
  },
  { id: 'matchStrength', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Match strength', group: 'Finish', default: 45, visibleWhen: { id: 'matching', in: ['neck', 'body', 'both'] } },
  {
    id: 'compareMode',
    type: 'enum',
    label: 'Comparison overlay',
    group: 'Review',
    options: [
      { value: 'none', label: 'None' },
      { value: 'sideBySide', label: 'Side-by-side reference' },
      { value: 'difference', label: 'Difference map' },
    ],
    default: 'none',
    help: 'Adds a hidden reference group so the original is always one click away inside Photoshop too, not only in this panel.',
  },
  { id: 'referenceOpacity', type: 'range', min: 5, max: 100, step: 1, unit: '%', label: 'Difference map opacity', group: 'Review', default: 60, visibleWhen: { id: 'compareMode', equals: 'difference' } },
  { id: 'maskFeather', type: 'range', min: 0, max: 40, step: 0.5, unit: 'px', label: 'Mask feather', group: 'Output', default: 6 },
  { id: 'opacity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Group opacity', group: 'Output', default: 100 },
]);

export class FinalReviewEngine extends ProcessingEngine {
  constructor() {
    super({ id: 'final-review', label: 'Final Review', schema: FINAL_REVIEW_SCHEMA });
  }

  process(frame, s, ctx) {
    const analysis = ctx.analysis || ctx.resolver.analyse(frame);
    const original = ctx.original || analysis.frame || frame;
    const { width, height, pixelCount } = frame;

    const selection = ctx.resolver.selectionMask(analysis, { region: s.region }, {
      feather: s.maskFeather,
      customMask: ctx.customMask,
      customRect: ctx.customRect,
    });
    const skin = analysis.skin && analysis.skin.length === pixelCount ? analysis.skin : fullMask(pixelCount);
    const scope = intersectMasks([selection, skin]);
    const skinCoverage = maskCoverage(scope);

    const checks = runReviewChecks({ frame, original, analysis, scope, settings: s });

    // ---- Optional finish passes -------------------------------------------
    const finish = [];
    let working = frame;

    if (s.refineRemaining && skinCoverage > 0.0005) {
      const refined = refineLeftoverTexture(working, scope, s);
      finish.push(refined);
      working = refined.preview;
    }

    if (s.evenSkin && skinCoverage > 0.0005) {
      const evened = evenRemainingTone(working, scope, s, analysis);
      finish.push(evened);
      working = evened.preview;
    }

    if (s.matching !== 'off') {
      const matched = matchFaceToBody(working, analysis, s, ctx);
      if (matched) {
        finish.push(matched);
        working = matched.preview;
      }
    }

    // ---- Diagnostic layers (never change the composite except false colour,
    //      which the retoucher explicitly asks for and can turn off) ----------
    const diagnostics = [];
    const falseColourLayer = s.falseColour > 0
      ? pixelLayer('Review — false colour (judgement view)', falseColourMap(frame, analysis), {
          blendMode: 'normal',
          opacity: Math.round(clamp(s.falseColour, 0, 100) * 0.55),
          visible: true,
          mask: scaleMask(scope, 1),
          note: 'Colour-only map of tone evenness on skin. Pores and features drop out; blotchiness and colour drift stand out. Purely a judgement view - turn it off for delivery.',
        })
      : null;

    const reference = s.compareMode === 'difference'
      ? pixelLayer('Review — difference map (retouch amount)', differenceMap(original, frame), {
          blendMode: 'normal',
          opacity: Math.round(clamp(s.referenceOpacity, 5, 100)),
          visible: false,
          mask: null,
          note: 'Starts hidden. Green = untouched, warm = lifted, cool = darkened; brightness of the wash is the size of the change.',
        })
      : s.compareMode === 'sideBySide'
        ? pixelLayer('Review — original reference (starts hidden)', original.clone(), {
            blendMode: 'normal',
            opacity: 100,
            visible: false,
            mask: null,
            note: 'A frozen copy of the original pixels. Toggle its eye to compare at any time; nothing else in the stack depends on it.',
          })
        : null;
    if (reference) diagnostics.push(reference);

    const notes = buildNotes(checks, { selection: s.region, original, frame });

    const layers = [
      group(
        ctx.layerName || 'Photografix — Skin Studio · Final Review',
        [
          ...(falseColourLayer ? [falseColourLayer] : []),
          ...finish.filter((f) => f.layer).map((f) => f.layer).reverse(),
          ...diagnostics,
          adjustmentLayer(
            'Review — tonal safety (levels, clipped)',
            { type: 'levels', input: safeLevels(checks.exposure) },
            {
              opacity: 0,
              mask: scaleMask(scope, 1),
              note: 'Pre-wired and set to 0%. If the histogram check reports clipped highlights or crushed shadows, raise this instead of re-running a stage.',
            },
          ),
          adjustmentsReferenceLayer(checks),
        ],
        { opacity: s.opacity },
      ),
    ];

    const preview = ctx.renderStack ? ctx.renderStack(layers, frame) : working;
    const skinStats = summariseSkin(frame, scope);

    return {
      layers,
      preview,
      mask: scope,
      report: {
        stage: 7,
        checks,
        notes,
        finish: finish.map((f) => f.id),
        skinCoveragePct: Math.round(skinCoverage * 1000) / 10,
        melanin: skinStats?.melanin ?? 0,
        undertone: skinStats?.undertone ?? 'unknown',
        medianLuma: Math.round(checks.exposure.medianLuma),
      },
      analysis: {
        ...checks,
        selectionCoverage: skinCoverage,
        faceConfidence: analysis.face?.confidence ?? 0,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Objective review of the current composite against the untouched original.
 * Everything is measured inside `scope` only, so a background gradient or a
 * necklace cannot be mistaken for a skin problem.
 */
export const runReviewChecks = ({ frame, original, analysis, scope, settings }) => {
  const tex = textureLoss(original, frame, scope);
  const halo = detectEdgeHalo(frame, analysis, scope, settings.haloThreshold, original);
  const melanin = melaninDrift(original, frame, scope);
  // The allowance is MELANIN-SCALED: "never auto-brighten deep skin" means the check
  // must be tightest where melanin is highest, and can be relaxed where a lighter
  // tone legitimately gains light from dodge/burn and gloss. A single flat tolerance
  // either alarms on every normal light-skin retouch or is too loose to protect deep
  // skin - both are worse than scaling it.
  const allowance = melaninAllowanceFor(original, scope, settings.melaninTolerance);
  melanin.allowance = allowance.value;
  melanin.melanin = allowance.melanin;
  const exposure = exposureSafety(frame, original, scope);
  const match = faceBodyMatch(frame, analysis);
  const globalMean = globalDelta(original, frame);

  const alerts = [];
  if (tex.lossPct > settings.textureThreshold) {
    alerts.push({
      id: 'texture',
      level: tex.lossPct > settings.textureThreshold * 1.6 ? 'high' : 'medium',
      message: `Texture is ${tex.lossPct.toFixed(0)}% below the original in the reviewed area — reduce the texture layers or lower pore replacement before delivery.`,
    });
  }
  if (halo.found) {
    alerts.push({
      id: 'halo',
      level: halo.maxDelta > settings.haloThreshold * 2 ? 'high' : 'medium',
      message: `An edge band appeared along ${halo.side} (${halo.maxDelta.toFixed(0)} levels brighter or darker than the original rim). Tighten the mask feather or paint the mask back at the jaw and shoulders.`,
    });
  }
  if (melanin.direction !== 'stable' && Math.abs(melanin.deltaL) > allowance.value) {
    alerts.push({
      id: 'melanin',
      level: Math.abs(melanin.deltaL) > allowance.value * 2 ? 'high' : 'medium',
      message: `Median skin lightness moved ${melanin.deltaL > 0 ? '+' : ''}${melanin.deltaL.toFixed(1)} L* (${melanin.direction}) against an allowance of ${allowance.value.toFixed(1)} L* for skin at melanin ${allowance.melanin.toFixed(2)}. Deep skin must not be brightened — check the skin-tone and grade groups.`,
    });
  }
  if (exposure.clippedPct > 0.5) {
    alerts.push({ id: 'clipping', level: exposure.clippedPct > 2 ? 'high' : 'medium', message: `${exposure.clippedPct.toFixed(1)}% of reviewed skin is clipped — pull back highlights before delivery.` });
  }
  if (exposure.crushedPct > 0.5) {
    alerts.push({ id: 'shadows', level: exposure.crushedPct > 2 ? 'high' : 'medium', message: `${exposure.crushedPct.toFixed(1)}% of reviewed skin has lost shadow detail — this is where deep skin starts to look flat.` });
  }
  if (match.faceNeck.deltaChroma > 8) {
    alerts.push({
      id: 'face-neck',
      level: match.faceNeck.deltaChroma > 14 ? 'high' : 'medium',
      message: `Face and neck differ by ${match.faceNeck.deltaChroma.toFixed(1)} chroma units. Match them, or the retouch will read as two different people.`,
    });
  }
  if (match.faceBody.deltaL > 6) {
    alerts.push({ id: 'face-body', level: 'medium', message: `Face is ${match.faceBody.deltaL.toFixed(1)} L* away from the chest — check flash falloff or grade masks.` });
  }

  return {
    texture: tex,
    halo,
    melanin,
    exposure,
    matching: match,
    global: globalMean,
    alerts,
    pass: alerts.filter((a) => a.level === 'high').length === 0,
    alertCount: alerts.filter((a) => a.level !== 'low').length,
  };
};

/** High-frequency energy inside the scope, original vs current. */
export const textureLoss = (original, current, scope) => {
  const before = highFrequencyEnergy(original, scope);
  const after = highFrequencyEnergy(current, scope);
  const lossPct = before > 0.05 ? Math.max(0, (1 - after / before) * 100) : 0;
  return {
    before: round(before),
    after: round(after),
    lossPct: round(lossPct, 1),
    plasticRisk: lossPct > 55 ? 'high' : lossPct > 38 ? 'medium' : 'low',
  };
};

const highFrequencyEnergy = (frame, scope) => {
  const lumaField = lumaArray(frame);
  const { width, height } = frame;
  const blurred = blurChannelArray(lumaField, width, height, 1.6);
  let sum = 0;
  let w = 0;
  for (let i = 0; i < lumaField.length; i++) {
    const m = scope ? scope[i] : 1;
    if (m <= 0.05) continue;
    sum += Math.abs(lumaField[i] - blurred[i]) * m;
    w += m;
  }
  return w > 0 ? sum / w : 0;
};

/**
 * Halo detection - measured as a CHANGE, not as absolute brightness.
 *
 * A lit face legitimately has a bright rim where skin meets a dark background, so
 * comparing skin to background directly reports every well-lit portrait as broken.
 * The retouch-introduced artefact is the difference between the rim contrast of the
 * ORIGINAL and the rim contrast of the current composite: a correct mask feathers
 * inward and leaves that difference near zero, while a spilled mask adds a bright
 * or dark band that the original never had.
 */
export const detectEdgeHalo = (frame, analysis, scope, threshold = 8, original = null) => {
  const { width, height } = frame;
  const subject = analysis.skin && analysis.skin.length === frame.pixelCount ? analysis.skin : fullMask(frame.pixelCount);
  const rimMask = buildRimMasks(subject, width, height, scope, 2);
  const current = rimContrast(lumaArray(frame), rimMask, width, height);
  const reference = original ? rimContrast(lumaArray(original), rimMask, width, height) : { left: 0, right: 0, delta: 0 };

  const left = current.left - reference.left;
  const right = current.right - reference.right;
  const magnitude = Math.max(Math.abs(left), Math.abs(right));
  return {
    found: magnitude > threshold && rimMask.innerCount > 20 && rimMask.outerCount > 20,
    left: round(left, 1),
    right: round(right, 1),
    maxDelta: round(magnitude, 1),
    edges: rimMask.innerCount,
    side: Math.abs(left) >= Math.abs(right) ? 'the left edge' : 'the right edge',
    threshold,
    baseline: round(reference.delta, 1),
    measured: 'introduced halo (current rim contrast minus original rim contrast)',
  };
};

const buildRimMasks = (subject, width, height, scope, ring) => {
  const inner = new Float32Array(width * height);
  const outer = new Float32Array(width * height);
  let innerCount = 0;
  let outerCount = 0;
  for (let y = ring; y < height - ring; y++) {
    for (let x = ring; x < width - ring; x++) {
      const i = y * width + x;
      if (scope && scope[i] < 0.35) continue;
      const here = subject[i] > 0.5;
      let edge = false;
      for (let k = 0; k < 8 && !edge; k++) {
        const ang = (k / 8) * Math.PI * 2;
        const sx = Math.round(x + Math.cos(ang) * ring);
        const sy = Math.round(y + Math.sin(ang) * ring);
        if (subject[sy * width + sx] > 0.5 !== here) edge = true;
      }
      if (!edge) continue;
      if (here) {
        inner[i] = 1;
        innerCount++;
      } else {
        outer[i] = 1;
        outerCount++;
      }
    }
  }
  return { inner, outer, innerCount, outerCount, ring };
};

const rimContrast = (lumaField, rimMask, width, height) => {
  const side = (from, to) => {
    let inSum = 0;
    let inCount = 0;
    let outSum = 0;
    let outCount = 0;
    for (let y = 0; y < height; y++) {
      for (let x = from; x < to; x++) {
        const i = y * width + x;
        if (rimMask.inner[i]) {
          inSum += lumaField[i];
          inCount++;
        }
        if (rimMask.outer[i]) {
          outSum += lumaField[i];
          outCount++;
        }
      }
    }
    return inCount && outCount ? inSum / inCount - outSum / outCount : 0;
  };
  const half = Math.floor(width / 2);
  const left = side(0, half);
  const right = side(half, width);
  return { left, right, delta: (left + right) / 2 };
};

/**
 * The melanin-scaled lightness allowance.
 *
 * At melanin 1.0 (the deepest skin) the allowance is exactly the slider value; at
 * melanin 0 it is roughly twice that, because light-skin retouches pick up real light
 * from dodge/burn and gloss and should not be nagged at. The direction of the rule is
 * never relaxed: brightening deep skin is what the reviewer exists to catch.
 */
export const melaninAllowanceFor = (original, scope, tolerance) => {
  const stats = summariseSkin(original, scope);
  const melanin = clamp(stats?.melanin ?? 0.5, 0, 1);
  const value = tolerance * (1 + 1.1 * (1 - melanin));
  return { value, melanin };
};

/** Median L* of the original vs the current composite inside the scope. */
export const melaninDrift = (original, current, scope) => {
  const before = medianSkinL(original, scope);
  const after = medianSkinL(current, scope);
  const deltaL = after - before;
  return {
    before: round(before, 1),
    after: round(after, 1),
    deltaL: round(deltaL, 1),
    direction: Math.abs(deltaL) < 1 ? 'stable' : deltaL > 0 ? 'brightened' : 'darkened',
  };
};

const medianSkinL = (frame, scope) => {
  const values = [];
  for (let i = 0; i < frame.pixelCount; i++) {
    if (scope && scope[i] < 0.5) continue;
    values.push(rgbToLab(frame.r[i], frame.g[i], frame.b[i]).L);
  }
  if (!values.length) return 0;
  const sorted = values.sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

/** Clipping / crushing statistics restricted to the reviewed area. */
export const exposureSafety = (frame, original, scope) => {
  const hist = computeHistogram(frame);
  let total = 0;
  let clipped = 0;
  let crushed = 0;
  for (let i = 0; i < frame.pixelCount; i++) {
    const m = scope ? scope[i] : 1;
    if (m < 0.5) continue;
    total++;
    const v = luma(frame.r[i], frame.g[i], frame.b[i]);
    if (v >= 252) clipped++;
    if (v <= 3) crushed++;
  }
  return {
    medianLuma: percentileFromHistogram(hist, 0.5),
    p01: percentileFromHistogram(hist, 0.01),
    p99: percentileFromHistogram(hist, 0.99),
    clippedPct: total ? (clipped / total) * 100 : 0,
    crushedPct: total ? (crushed / total) * 100 : 0,
    sharpness: round(estimateSharpness(frame), 2),
    reviewedPixels: total,
  };
};

/** Colour relationship between face, neck and chest. */
export const faceBodyMatch = (frame, analysis) => {
  const zones = analysis.body?.zones || {};
  const faceMask = analysis.headSkin && analysis.headSkin.length === frame.pixelCount ? analysis.headSkin : null;
  const meanOf = (mask) => meanLabInMask(frame, mask);
  const face = faceMask ? meanOf(faceMask) : null;
  const neck = zones.neck ? meanOf(zones.neck) : null;
  const chest = zones.chest ? meanOf(zones.chest) : null;
  const diff = (a, b) =>
    a && b
      ? {
          deltaL: round(b.L - a.L, 2),
          deltaA: round(b.a - a.a, 2),
          deltaB: round(b.b - a.b, 2),
          deltaChroma: round(Math.hypot(b.a - a.a, b.b - a.b), 2),
        }
      : { deltaL: 0, deltaA: 0, deltaB: 0, deltaChroma: 0 };
  return {
    face: face ? roundLab(face) : null,
    neck: neck ? roundLab(neck) : null,
    chest: chest ? roundLab(chest) : null,
    faceNeck: diff(face, neck),
    faceBody: diff(face, chest),
    available: Boolean(face && (neck || chest)),
  };
};

const meanLabInMask = (frame, mask) => {
  if (!mask) return null;
  let L = 0;
  let a = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i];
    if (m < 0.5) continue;
    const lab = rgbToLab(frame.r[i], frame.g[i], frame.b[i]);
    L += lab.L * m;
    a += lab.a * m;
    b += lab.b * m;
    w += m;
  }
  return w > 0 ? { L: L / w, a: a / w, b: b / w } : null;
};

const globalDelta = (original, current) => {
  let max = 0;
  let sum = 0;
  for (let i = 0; i < original.pixelCount; i++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(current.channels[c][i] - original.channels[c][i]);
      sum += d;
      if (d > max) max = d;
    }
  }
  return { meanDelta: round(sum / (original.pixelCount * 3), 2), maxDelta: round(max, 1) };
};

// ---------------------------------------------------------------------------
// Finish tools
// ---------------------------------------------------------------------------

/**
 * One last blemish pass. Protect-first: the mask is the reviewed skin minus
 * everything that is already detail (pores, lashes, lip edges), so this can only
 * ever soften what every earlier stage left behind.
 */
export const refineLeftoverTexture = (frame, scope, s) => {
  const { width, height } = frame;
  const radius = clamp(s.refineRadius, 2, 24);
  const strength = clamp(s.refineStrength, 0, 100) / 100;
  if (strength <= 0) return { id: 'refine', layer: null, preview: frame, mask: emptyMask(frame.pixelCount) };

  const low = blurFrame(frame, radius);
  const detail = detailProtectionMask(frame, { threshold: 0.12, softness: 0.05, radius: 2 });
  let mask = intersectMasks([scope, detail]);
  mask = refineMask(mask, width, height, { feather: Math.max(2, radius * 0.8), expand: 0, smooth: 1, speckleRadius: 1 });

  // Correct tone only where the pixel deviates from its neighbourhood, and only
  // a fraction of the way, so a stray mark fades instead of vanishing.
  const out = frame.clone();
  for (let c = 0; c < 3; c++) {
    const f = frame.channels[c];
    const l = low.channels[c];
    const o = out.channels[c];
    for (let i = 0; i < o.length; i++) {
      const m = mask[i] * strength * 0.6;
      if (m <= 0.001) continue;
      o[i] = clamp(f[i] + (l[i] - f[i]) * m, 0, 255);
    }
  }

  return {
    id: 'refine',
    mask,
    preview: out,
    layer: pixelLayer(`Finish — remaining blemishes (${Math.round(strength * 100)}%)`, out, {
      blendMode: 'normal',
      opacity: 100,
      mask,
      note: 'Rendered at 60% of the requested strength: the retoucher can still brush this in. Mask protects pores and features.',
    }),
  };
};

/**
 * Even remaining colour without touching luminance. Chroma is pulled toward the
 * local median, L is left exactly where it is - the one rule that keeps melanin
 * untouched while still evening out blotchiness.
 */
export const evenRemainingTone = (frame, scope, s, analysis) => {
  const { width, height } = frame;
  const amount = clamp(s.evenStrength, 0, 100) / 100;
  if (amount <= 0) return { id: 'even', layer: null, preview: frame, mask: emptyMask(frame.pixelCount) };

  const radius = Math.max(4, Math.round(Math.min(width, height) * 0.06));
  const low = blurFrame(frame, radius);
  const out = frame.clone();
  for (let i = 0; i < frame.pixelCount; i++) {
    const m = scope[i] * amount;
    if (m <= 0.001) continue;
    const cur = rgbToLab(frame.r[i], frame.g[i], frame.b[i]);
    const ref = rgbToLab(low.r[i], low.g[i], low.b[i]);
    const a = cur.a + (ref.a - cur.a) * m;
    const b = cur.b + (ref.b - cur.b) * m;
    const rgb = labToRgb(cur.L, a, b);
    out.r[i] = clamp(rgb.r, 0, 255);
    out.g[i] = clamp(rgb.g, 0, 255);
    out.b[i] = clamp(rgb.b, 0, 255);
  }

  const mask = refineMask(scope, width, height, { feather: 4, expand: 0, smooth: 1, speckleRadius: 1 });
  return {
    id: 'even',
    mask,
    preview: out,
    layer: pixelLayer('Finish — complexion evenness (chroma only)', out, {
      blendMode: 'normal',
      opacity: 100,
      mask,
      note: 'Corrects uneven colour only. Luminance is preserved pixel by pixel, so melanin and skin depth are untouched.',
    }),
  };
};

/**
 * Bring the face back toward the neck / chest colour. Moves chroma and only a
 * gentle part of luminance, and never more than a few levels in either direction.
 */
export const matchFaceToBody = (frame, analysis, s, ctx) => {
  const zones = analysis.body?.zones || {};
  const faceMask = analysis.headSkin && analysis.headSkin.length === frame.pixelCount ? analysis.headSkin : null;
  if (!faceMask) return null;
  const face = meanLabInMask(frame, faceMask);
  if (!face) return null;
  const targets = [];
  if ((s.matching === 'neck' || s.matching === 'both') && zones.neck) {
    const neck = meanLabInMask(frame, zones.neck);
    if (neck) targets.push({ label: 'neck', lab: neck, mask: zones.neck });
  }
  if ((s.matching === 'body' || s.matching === 'both') && zones.chest) {
    const chest = meanLabInMask(frame, zones.chest);
    if (chest) targets.push({ label: 'body', lab: chest, mask: zones.chest });
  }
  if (!targets.length) return null;

  // Weighted target: the neck matters most because it is the visible bridge.
  let wSum = 0;
  let tL = 0;
  let tA = 0;
  let tB = 0;
  for (const t of targets) {
    const w = t.label === 'neck' ? 1.4 : 1;
    tL += t.lab.L * w;
    tA += t.lab.a * w;
    tB += t.lab.b * w;
    wSum += w;
  }
  tL /= wSum;
  tA /= wSum;
  tB /= wSum;

  const strength = clamp(s.matchStrength, 0, 100) / 100;
  // Never move more than this: matching is a nudge, not a re-grade.
  const dA = clamp((tA - face.a) * strength, -6, 6);
  const dB = clamp((tB - face.b) * strength, -6, 6);
  const dL = clamp((tL - face.L) * strength * 0.35, -3.5, 3.5);

  const out = frame.clone();
  for (let i = 0; i < frame.pixelCount; i++) {
    const m = faceMask[i] * (faceMask[i] > 0.02 ? 1 : 0);
    if (m <= 0.001) continue;
    const cur = rgbToLab(out.r[i], out.g[i], out.b[i]);
    const rgb = labToRgb(clamp(cur.L + dL, 0, 100), cur.a + dA, cur.b + dB);
    out.r[i] = clamp(out.r[i] + (rgb.r - out.r[i]) * m, 0, 255);
    out.g[i] = clamp(out.g[i] + (rgb.g - out.g[i]) * m, 0, 255);
    out.b[i] = clamp(out.b[i] + (rgb.b - out.b[i]) * m, 0, 255);
  }

  const mask = refineMask(faceMask, frame.width, frame.height, { feather: 6, expand: 0, smooth: 1, speckleRadius: 1 });
  return {
    id: 'match',
    mask,
    preview: out,
    layer: pixelLayer(`Finish — face matched to ${targets.map((t) => t.label).join(' + ')}`, out, {
      blendMode: 'normal',
      opacity: 100,
      mask,
      note: `Chroma nudged by a*/b* ${dA.toFixed(1)}/${dB.toFixed(1)} and lightness by ${dL.toFixed(1)} L* at most. Mask is the face only - the neck is never touched.`,
    }),
  };
};

// ---------------------------------------------------------------------------
// Diagnostic visuals
// ---------------------------------------------------------------------------

/**
 * False-colour judgement view.
 *
 * Pushes local chroma deviation into a simple green/red/magenta map: flat colour
 * reads neutral, red and magenta patches show where the tone is uneven. Skin
 * texture (which is luminance) drops out, so the eye sees only complexion.
 */
export const falseColourMap = (frame, analysis) => {
  const { width, height } = frame;
  const low = blurFrame(frame, Math.max(6, Math.round(Math.min(width, height) * 0.05)));
  const out = new Frame(width, height);
  for (let i = 0; i < frame.pixelCount; i++) {
    const cur = rgbToLab(frame.r[i], frame.g[i], frame.b[i]);
    const ref = rgbToLab(low.r[i], low.g[i], low.b[i]);
    const da = clamp((cur.a - ref.a) / 10, -1.5, 1.5);
    const db = clamp((cur.b - ref.b) / 10, -1.5, 1.5);
    const l = 40 + (cur.L - 40) * 0.35;
    let r = l + da * 120 - db * 20;
    let g = l - da * 60 + db * 40;
    let b = l - da * 90 + db * 130;
    out.r[i] = clamp(r, 0, 255);
    out.g[i] = clamp(g, 0, 255);
    out.b[i] = clamp(b, 0, 255);
  }
  return out;
};

/** Difference map: how much each pixel moved from the original. */
export const differenceMap = (original, current) => {
  const out = new Frame(original.width, original.height);
  for (let i = 0; i < original.pixelCount; i++) {
    const dr = current.r[i] - original.r[i];
    const dg = current.g[i] - original.g[i];
    const db = current.b[i] - original.b[i];
    const mag = Math.min(1, Math.hypot(dr, dg, db) / 26);
    const warm = dr + dg >= 0;
    // grey base so untouched areas read as neutral, not black
    const base = 40 + mag * 90;
    out.r[i] = clamp(base + (warm ? mag * 130 : 0), 0, 255);
    out.g[i] = clamp(base + mag * 40, 0, 255);
    out.b[i] = clamp(base + (warm ? 0 : mag * 130), 0, 255);
  }
  return out;
};

/** Levels adjustment that rescues clipping without touching anything else. */
const safeLevels = (exposure) => {
  const inBlack = clamp(Math.round(exposure.p01 - 1), 0, 24);
  const inWhite = clamp(Math.round(exposure.p99 + 2), 231, 255);
  return { inBlack, inWhite, gamma: 1, outBlack: 0, outWhite: 255 };
};

const adjustmentsReferenceLayer = (checks) =>
  adjustmentLayer(
    'Review — curves (identity, safety copy)',
    { type: 'curves', luma: identityCurve(checks) },
    {
      opacity: 0,
      mask: null,
      note: 'Identity curve kept at 0%. Duplicate it to start a corrective curve without re-running any stage; the histogram warnings above tell you which end to move.',
    },
  );

const identityCurve = () => [[0, 0], [64, 64], [128, 128], [192, 192], [255, 255]];

// ---------------------------------------------------------------------------
// Notes for the panel
// ---------------------------------------------------------------------------

const buildNotes = (checks, { selection, original, frame }) => {
  const notes = [];
  if (checks.alerts.length === 0) {
    notes.push('No safety alerts: texture, tone, edges and exposure are all inside their limits.');
  }
  for (const alert of checks.alerts) notes.push(alert.message);
  if (checks.texture.lossPct > 25 && checks.texture.lossPct <= 38) {
    notes.push(`Texture is ${checks.texture.lossPct.toFixed(0)}% below the original — still natural, watch it if you add more.`);
  }
  if (checks.melanin.direction === 'stable') {
    notes.push(`Median skin lightness held (${checks.melanin.before.toFixed(1)} → ${checks.melanin.after.toFixed(1)} L*).`);
  }
  if (checks.matching.available) {
    notes.push(`Face/neck chroma difference: ${checks.matching.faceNeck.deltaChroma.toFixed(1)}; face/body lightness difference: ${checks.matching.faceBody.deltaL.toFixed(1)} L*.`);
  }
  notes.push(`Reviewed ${selection === 'custom' ? 'the custom selection' : selection} at ${original.width}×${original.height}; global change mean ${checks.global.meanDelta.toFixed(2)}, peak ${checks.global.maxDelta.toFixed(0)} levels.`);
  return notes;
};

const round = (v, d = 2) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

const roundLab = (lab) => ({ L: round(lab.L, 1), a: round(lab.a, 1), b: round(lab.b, 1) });
