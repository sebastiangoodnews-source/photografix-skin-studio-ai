import { clamp, smoothstep, luma } from '../util/math.js';
import { defineSchema } from '../util/params.js';
import { Frame } from '../image/frame.js';
import { blurFrame, blurChannelArray } from '../image/filters.js';
import { lumaArray } from '../analysis/histogram.js';
import { faceRegionMasks } from '../segmentation/face.js';
import { intersectMasks, unionMasks, tonalMask, refineMask, createProtectionMask, scaleMask, detailProtectionMask } from '../masks/masks.js';
import { group, pixelLayer } from '../layers/record.js';
import { ProcessingEngine, blendWithMask, medianApprox } from './common.js';
import { INTENSITY_STEPS } from '../../config/presets.js';

/**
 * MicroDodgeBurnEngine
 *
 * Purpose: correct SMALL tonal inconsistencies - patchiness, stray shadows,
 * uneven redness, under-eye darkness - on face AND body. It deliberately does not
 * shape form (that is the sculpt engine).
 *
 * Implementation is a local-tonal-equalisation dodge & burn:
 *
 *   deviation = reference - original          (reference = large-radius median/blur)
 *   correction = deviation * strength * masks  (sign decides dodge vs burn)
 *
 * The reference is a robust local median, so blemishes and hair do not drag the
 * correction. Corrections are split into separate highlight / shadow / midtone
 * layers the way a retoucher builds them with two curves, which is what makes the
 * result paintable and re-tunable afterwards.
 */

export const MICRO_DB_SCHEMA = defineSchema([
  {
    id: 'target',
    type: 'enum',
    label: 'Target',
    group: 'Target',
    options: [
      { value: 'face', label: 'Face' },
      { value: 'body', label: 'Body' },
      { value: 'faceBody', label: 'Face + body' },
    ],
    default: 'face',
  },
  {
    id: 'intensity',
    type: 'enum',
    label: 'Intensity',
    group: 'Target',
    options: [
      { value: 'very-subtle', label: 'Very subtle' },
      { value: 'subtle', label: 'Subtle' },
      { value: 'natural', label: 'Natural' },
      { value: 'medium', label: 'Medium' },
      { value: 'strong', label: 'Strong' },
      { value: 'custom', label: 'Custom' },
    ],
    default: 'subtle',
    help: 'Sets the strength multiplier. Custom leaves the raw sliders in charge.',
  },
  { id: 'strength', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Strength', group: 'Correction', default: 30 },
  { id: 'opacity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Layer opacity', group: 'Correction', default: 100 },
  { id: 'highlightIntensity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Highlight intensity', group: 'Correction', default: 35 },
  { id: 'shadowIntensity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Shadow intensity', group: 'Correction', default: 30 },
  { id: 'midtoneCorrection', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Midtone correction', group: 'Correction', default: 40 },
  { id: 'radius', type: 'range', min: 4, max: 120, step: 1, unit: 'px', label: 'Correction radius', group: 'Correction', default: 26, help: 'Scale of the inconsistency being corrected. Small for pores and stray shadows, large for broad patchiness.' },
  { id: 'edgePreserve', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Edge preservation', group: 'Correction', default: 70, help: 'Stops corrections from bleeding across eyes, lips, nostrils and hair.' },
  { id: 'underEye', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Under-eye lift', group: 'Zones', default: 45 },
  { id: 'forehead', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Forehead balancing', group: 'Zones', default: 40 },
  { id: 'noseHighlight', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Nose highlight refinement', group: 'Zones', default: 30 },
  { id: 'cheeks', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Cheek correction', group: 'Zones', default: 40 },
  { id: 'lipArea', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Lip-area tonal correction', group: 'Zones', default: 25 },
  { id: 'neck', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Neck correction', group: 'Zones', default: 45 },
  { id: 'arms', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Arm correction', group: 'Zones', default: 35 },
  { id: 'legs', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Leg correction', group: 'Zones', default: 35 },
  { id: 'bodyBalance', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Body tonal balancing', group: 'Zones', default: 40 },
  { id: 'maskRefinement', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Mask refinement', group: 'Masks', default: 60 },
  { id: 'brushSize', type: 'range', min: 5, max: 400, step: 1, unit: 'px', label: 'Brush size', group: 'Brush', default: 120, help: 'Sets the Photoshop brush the panel prepares for manual refinement.' },
  { id: 'brushSoftness', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Brush softness', group: 'Brush', default: 60 },
  { id: 'brushFlow', type: 'range', min: 1, max: 100, step: 1, unit: '%', label: 'Brush flow', group: 'Brush', default: 25 },
  { id: 'region', type: 'enum', label: 'Processing region', group: 'Target', options: [
    { value: 'face', label: 'Face' },
    { value: 'neck', label: 'Neck' },
    { value: 'chest', label: 'Chest' },
    { value: 'arms', label: 'Arms' },
    { value: 'legs', label: 'Legs' },
    { value: 'fullBody', label: 'Full body' },
    { value: 'custom', label: 'Custom selection' },
  ], default: 'face' },
  { id: 'maskFeather', type: 'range', min: 0, max: 30, step: 0.5, unit: 'px', label: 'Mask feather', group: 'Masks', default: 8 },
]);

export class MicroDodgeBurnEngine extends ProcessingEngine {
  constructor() {
    super({ id: 'micro-dodge-burn', label: 'Micro Dodge & Burn', schema: MICRO_DB_SCHEMA });
  }

  process(frame, s, ctx) {
    const analysis = ctx.analysis || ctx.resolver.analyse(frame);
    const { width, height, pixelCount } = frame;

    const strength = resolveIntensityScale(s.intensity, s.strength);
    const coverage = this.buildCoverage(frame, analysis, s, ctx);
    const lum = lumaArray(frame);

    // Robust local reference: median removes blemishes, blur gives smooth transitions.
    const radius = Math.max(4, s.radius);
    const median = medianApprox(lum, width, height, Math.max(3, Math.round(radius * 0.45)));
    const blurred = blurChannelArray(lum, width, height, radius * 0.6);
    const reference = new Float32Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) reference[i] = median[i] * 0.65 + blurred[i] * 0.35;

    const features = detailProtectionMask(frame, { threshold: 0.12, softness: 0.05, radius: 2 });
    const edgeGuard = clamp(s.edgePreserve / 100);
    const protection = createProtectionMask(frame, {
      highlightSafety: ctx.core?.highlightSafety ? ctx.core.highlightSafety / 100 : 0.9,
      shadowSafety: ctx.core?.shadowSafety ? ctx.core.shadowSafety / 100 : 0.8,
    });
    const shadows = tonalMask(frame, 'shadows', { softness: 0.35 });
    const midtones = tonalMask(frame, 'midtones', { softness: 0.4 });
    const highlights = tonalMask(frame, 'highlights', { softness: 0.3 });

    const hiWeight = (s.highlightIntensity / 100) * strength;
    const shWeight = (s.shadowIntensity / 100) * strength;
    const midWeight = (s.midtoneCorrection / 100) * strength;

    const highlightLayer = new Frame(width, height);
    const shadowLayer = new Frame(width, height);
    const midtoneLayer = new Frame(width, height);
    const combined = frame.clone();
    const correctionMap = new Float32Array(pixelCount);

    for (let i = 0; i < pixelCount; i++) {
      const cov = coverage[i];
      if (cov <= 0.001) continue;
      const deviation = reference[i] - lum[i]; // >0 => pixel is darker than local ref => lift
      // features is a PROTECTION mask (1 on skin, 0 across eyes/lips/hair)
      const featureGuard = 1 - (1 - features[i]) * edgeGuard;
      const guard = cov * featureGuard * protection[i];

      // Split the correction by tonal band so each target gets the right layer.
      const toShadow = deviation > 0 ? deviation * shWeight * shadows[i] : 0;
      const toHighlight = deviation < 0 ? deviation * hiWeight * highlights[i] : 0;
      const toMid = deviation * midWeight * midtones[i];
      const total = (toShadow + toHighlight + toMid) * guard * 0.55;

      if (Math.abs(total) < 0.01) continue;
      correctionMap[i] = total;

      const delta = total;
      for (let c = 0; c < 3; c++) {
        const v = clamp(frame.channels[c][i] + delta, 0, 255);
        if (delta > 0) {
          // lift written into the shadow layer, neutral (flat grey) elsewhere
          highlightLayer.channels[c][i] = 128 + delta * 0.5;
          shadowLayer.channels[c][i] = 128;
        } else {
          shadowLayer.channels[c][i] = 128 + delta * 0.5;
          highlightLayer.channels[c][i] = 128;
        }
        midtoneLayer.channels[c][i] = 128 + total * 0.4;
        combined.channels[c][i] = v;
      }
    }
    fillNeutralRange(highlightLayer, pixelCount, 128);
    fillNeutralRange(shadowLayer, pixelCount, 128);
    fillNeutralRange(midtoneLayer, pixelCount, 128);

    let mask = refineMask(coverage, width, height, {
      feather: s.maskFeather,
      expand: 0,
      smooth: 1,
      speckleRadius: 1,
      strength: s.maskRefinement / 100,
    });
    if (s.maskRefinement <= 0) mask = coverage;

    const brush = {
      size: s.brushSize,
      softness: s.brushSoftness,
      flow: s.brushFlow,
    };

    const layers = [
      group(
        ctx.layerName || 'Photografix — Skin Studio · Micro Dodge & Burn',
        [
          pixelLayer('Micro D&B — Highlights  (Linear Light)', highlightLayer, {
            blendMode: 'linearLight',
            opacity: s.opacity,
            mask,
            note: 'Lifts small dark distractions. Paint on the mask with a soft brush at low flow.',
          }),
          pixelLayer('Micro D&B — Shadows  (Linear Light)', shadowLayer, {
            blendMode: 'linearLight',
            opacity: s.opacity,
            mask,
            note: 'Burns small bright distractions and tames hot spots.',
          }),
          pixelLayer('Micro D&B — Midtones  (Soft Light)', midtoneLayer, {
            blendMode: 'softLight',
            opacity: s.opacity * 0.85,
            mask,
            note: 'Gentle midtone equalisation for overall skin balance.',
          }),
        ],
        { opacity: 100 },
      ),
    ];

    const preview = ctx.renderStack ? ctx.renderStack(layers, frame) : combined;

    return {
      layers,
      preview,
      mask,
      combined,
      correction: correctionMap,
      brush,
      analysis: {
        target: s.target,
        intensity: s.intensity,
        strength,
        meanCorrection: meanAbs(correctionMap),
        maxCorrection: maxAbs(correctionMap),
        coverage: coverageOf(mask),
      },
      report: {
        target: s.target,
        intensity: s.intensity,
        strengthScale: strength,
        layers: ['highlights', 'shadows', 'midtones'],
        brush,
      },
    };
  }

  buildCoverage(frame, analysis, s, ctx) {
    const { width, height, pixelCount } = frame;
    const base = ctx.resolver.selectionMask(analysis, { region: s.region }, {
      feather: s.maskFeather,
      customMask: ctx.customMask,
      customRect: ctx.customRect,
    });
    let mask = base;
    if (s.region === 'face' || s.region === 'fullBody' || s.target === 'faceBody') {
      mask = unionMasks([mask, analysis.body.skin || new Float32Array(pixelCount)]);
    }
    mask = intersectMasks([mask, analysis.skin]);

    // Zone weighting from the sliders: each zone scales how strongly that area is
    // corrected. Zones come from the face segmenter and the body segmenter.
    const weight = new Float32Array(pixelCount).fill(1);
    const applyZone = (zone, value) => {
      if (!zone || value === undefined) return;
      const w = clamp(value / 100);
      for (let i = 0; i < pixelCount; i++) {
        const z = zone[i];
        if (z <= 0.01) continue;
        weight[i] = weight[i] * (1 - z) + w * z;
      }
    };

    if (analysis.face?.found && (s.region === 'face' || s.region === 'fullBody' || s.target !== 'body')) {
      const zones = faceRegionMasks(frame, analysis.face, analysis.landmarks, { feather: Math.max(2, Math.round(s.radius * 0.3)) });
      applyZone(zones.underEye, s.underEye);
      applyZone(zones.forehead, s.forehead);
      applyZone(zones.nose, s.noseHighlight);
      applyZone(zones.cheeks, s.cheeks);
      applyZone(zones.lipArea, s.lipArea);
      // areas not explicitly listed keep the global strength
      const faceWeighted = unionMasks([
        zones.underEye,
        zones.forehead,
        zones.nose,
        zones.cheeks,
        zones.lipArea,
        zones.chin,
        zones.temples,
        zones.cheekbones,
        zones.jawline,
      ]);
      for (let i = 0; i < pixelCount; i++) {
        const remaining = clamp(1 - faceWeighted[i]);
        if (remaining > 0.01) weight[i] = weight[i] * (1 - remaining) + 1 * remaining;
      }
    }
    if (analysis.body.zones && s.target !== 'face') {
      const z = analysis.body.zones;
      applyZone(z.neck, s.neck);
      applyZone(z.arms, s.arms);
      applyZone(z.legs, s.legs);
      const bodyZones = unionMasks([z.neck, z.arms, z.legs].filter(Boolean));
      for (let i = 0; i < pixelCount; i++) {
        const remaining = clamp(1 - bodyZones[i]);
        const bodyW = clamp(s.bodyBalance / 100);
        if (remaining > 0.01) {
          weight[i] = weight[i] * remaining + Math.min(weight[i], bodyW) * (1 - remaining);
        }
      }
    }

    const out = new Float32Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) out[i] = clamp(mask[i] * weight[i]);
    return out;
  }
}

const fillNeutralRange = (frame, n, neutral) => {
  for (let c = 0; c < 3; c++) {
    const ch = frame.channels[c];
    for (let i = 0; i < n; i++) if (!ch[i]) ch[i] = neutral;
  }
};

export const resolveIntensityScale = (intensity, strengthPct) => {
  const strength = clamp(strengthPct / 100);
  const preset = INTENSITY_STEPS[intensity];
  if (preset === null || preset === undefined) return strength;
  // Presets scale the strength but never replace it, so the slider stays truthful.
  return clamp(strength * (0.45 + preset * 1.6), 0, 1.25);
};

const meanAbs = (arr) => {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += Math.abs(arr[i]);
  return arr.length ? s / arr.length : 0;
};
const maxAbs = (arr) => {
  let m = 0;
  for (let i = 0; i < arr.length; i++) m = Math.max(m, Math.abs(arr[i]));
  return m;
};
const coverageOf = (m) => {
  let s = 0;
  for (let i = 0; i < m.length; i++) s += m[i];
  return m.length ? s / m.length : 0;
};
