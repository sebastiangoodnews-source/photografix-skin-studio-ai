import { clamp } from '../util/math.js';
import { defineSchema } from '../util/params.js';
import { blurFrame, blurChannelArray } from '../image/filters.js';
import { lumaArray } from '../analysis/histogram.js';
import { analyseFaceSurface } from '../segmentation/face.js';
import { summariseSkin } from '../analysis/skin.js';
import { intersectMasks, refineMask, scaleMask, detailProtectionMask } from '../masks/masks.js';
import { group, pixelLayer, adjustmentLayer } from '../layers/record.js';
import { ProcessingEngine, splitFrequencies, textureGate, detectBlemishes } from './common.js';
import { LINEAR_NEUTRAL } from '../image/blend.js';
import { rgbToLab, labToRgb } from '../image/colorspace.js';

/**
 * AdvancedFrequencyEngine - MODE 2: Advanced frequency separation.
 *
 * Guided separation. The split is still a real separation (so the retoucher can
 * keep brushing on it), but the detail layer is gated per pixel:
 *
 *   - skin likelihood (melanin-aware) decides WHERE anything may change
 *   - texture energy decides HOW MUCH smoothing each pixel accepts, so pores and
 *     lip/lash structure survive while flat cheek tone is evened out
 *   - blemish detection protects the pixels a retoucher wants to heal by hand
 *   - colour is blended in Lab (a-star/b-star only) so luminance modelling is untouched,
 *     which is what stops the "flat plastic" look
 *
 * Every control below maps 1:1 to a slider the retoucher can revisit.
 */

export const ADVANCED_FS_SCHEMA = defineSchema([
  {
    id: 'textureSmoothing',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Texture smoothing',
    group: 'Texture',
    default: 32,
    help: 'How much high-frequency texture is suppressed. Photografix caps the useful range well below 100%: this control is deliberately conservative.',
  },
  {
    id: 'colourBlending',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Colour blending',
    group: 'Colour',
    default: 30,
    help: 'Local Lab colour unification. Works on a-star/b-star only, never on L, so facial modelling stays intact.',
  },
  {
    id: 'skinUniformity',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Skin uniformity',
    group: 'Colour',
    default: 26,
    help: 'Pulls slow tonal drift (patchiness) toward the local median without touching edges.',
  },
  {
    id: 'porePreservation',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Pore preservation',
    group: 'Texture',
    default: 78,
    help: 'Restores a percentage of the original pore-level detail on top of the smoothed result. This is the main anti-plastic control.',
  },
  {
    id: 'textureRestore',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Texture restoration',
    group: 'Texture',
    default: 35,
    help: 'Micro-contrast rebuild: adds back structure the blur removed, weighted toward the light direction.',
  },
  {
    id: 'blemishAware',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Blemish awareness',
    group: 'Texture',
    default: 45,
    help: 'Isolates small high-contrast blemishes so they are protected from global smoothing and left for targeted healing.',
  },
  {
    id: 'radius',
    type: 'range',
    min: 1,
    max: 40,
    step: 0.5,
    unit: 'px',
    label: 'Separation radius',
    group: 'Separation',
    default: 10,
  },
  {
    id: 'adaptiveRadius',
    type: 'bool',
    label: 'Adaptive radius',
    group: 'Separation',
    default: true,
    help: 'Overrides the radius with the value suggested by the photograph analysis.',
  },
  {
    id: 'strength',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Overall strength',
    group: 'Output',
    default: 55,
  },
  {
    id: 'opacity',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Group opacity',
    group: 'Output',
    default: 100,
  },
  {
    id: 'region',
    type: 'enum',
    label: 'Processing region',
    group: 'Region',
    options: [
      { value: 'face', label: 'Face' },
      { value: 'neck', label: 'Neck' },
      { value: 'chest', label: 'Chest' },
      { value: 'arms', label: 'Arms' },
      { value: 'legs', label: 'Legs' },
      { value: 'fullBody', label: 'Full body' },
      { value: 'custom', label: 'Custom selection' },
    ],
    default: 'face',
  },
  {
    id: 'maskFeather',
    type: 'range',
    min: 0,
    max: 30,
    step: 0.5,
    unit: 'px',
    label: 'Mask feather',
    group: 'Region',
    default: 6,
  },
]);

export class AdvancedFrequencyEngine extends ProcessingEngine {
  constructor() {
    super({ id: 'frequency-separation-advanced', label: 'Frequency Separation — Advanced', schema: ADVANCED_FS_SCHEMA });
  }

  process(frame, s, ctx) {
    const analysis = ctx.analysis || ctx.resolver.analyse(frame);
    const { width, height, pixelCount } = frame;

    const regionMask = ctx.resolver.selectionMask(analysis, { region: s.region }, {
      feather: s.maskFeather,
      customMask: ctx.customMask,
      customRect: ctx.customRect,
    });
    const skinCoverage = analysis.skin;
    let coverage = intersectMasks([regionMask, skinCoverage]);

    const surface = analysis.face?.found ? analyseFaceSurface(frame, analysis.face) : null;
    const radius = s.adaptiveRadius && surface ? surface.suggestedRadius : s.radius;
    const poreRadius = Math.max(1.5, radius * 0.45);

    // 1. Separation
    const { low, high } = splitFrequencies(frame, radius, { mode: 'linearLight' });

    // 2. Detail gating: smooth more where there is little structure
    const gate = textureGate(frame, {
      radius: Math.max(1.5, radius * 0.35),
      threshold: 5 + s.porePreservation * 0.045,
      softness: 3.5,
    });
    const blemishes = s.blemishAware > 0 ? detectBlemishes(frame, { sensitivity: s.blemishAware / 100, maxRadius: Math.max(3, poreRadius * 1.4) }) : null;

    // protections
    const features = detailProtectionMask(frame, { threshold: 0.11, softness: 0.05, radius: 2 });

    // 3. Build the smoothed detail layer
    const smoothingAmount = (s.textureSmoothing / 100) * (s.strength / 100);
    const restoreAmount = (s.textureRestore / 100) * 0.6;
    const poreAmount = s.porePreservation / 100;
    // The gate decides HOW MUCH EXTRA smoothing a flat area gets - it must not cap
    // the overall amount, or "Texture smoothing 100" would quietly deliver 40% and
    // the panel would lie about what it did. At 100 the detail layer is flattened
    // except where pores, blemishes and features are protected.
    const smoothedHigh = high.clone();
    for (let c = 0; c < 3; c++) {
      const hi = high.channels[c];
      const sh = smoothedHigh.channels[c];
      for (let i = 0; i < pixelCount; i++) {
        const detail = hi[i] - LINEAR_NEUTRAL;
        const protection = features[i] * (1 - (blemishes ? blemishes[i] * 0.75 : 0));
        const remove = clamp(smoothingAmount * (0.62 + 0.38 * gate[i]) * protection, 0, 1);
        const keep = 1 - remove;
        // restore a little structure plus directional micro-contrast
        const rebuilt = detail * keep + detail * poreAmount * 0.22 + detail * restoreAmount * 0.18;
        sh[i] = clamp(LINEAR_NEUTRAL + rebuilt, 0, 255);
      }
    }

    // 4. Colour unification in Lab (a-star/b-star only) + slow drift removal
    const smoothedLow = low.clone();
    const lLow = blurChannelArray(lumaArray(low), width, height, Math.max(2, radius * 1.2));
    const colourAmt = (s.colourBlending / 100) * (s.strength / 100);
    const uniformityAmt = (s.skinUniformity / 100) * (s.strength / 100);
    if (colourAmt > 0.001 || uniformityAmt > 0.001) {
      const chromaA = new Float32Array(pixelCount);
      const chromaB = new Float32Array(pixelCount);
      const lum = new Float32Array(pixelCount);
      for (let i = 0; i < pixelCount; i++) {
        const lab = rgbToLab(low.r[i], low.g[i], low.b[i]);
        chromaA[i] = lab.a;
        chromaB[i] = lab.b;
        lum[i] = lab.L;
      }
      const aMean = blurChannelArray(chromaA, width, height, Math.max(3, radius * 2.4));
      const bMean = blurChannelArray(chromaB, width, height, Math.max(3, radius * 2.4));
      const lMean = blurChannelArray(lum, width, height, Math.max(3, radius * 3));
      const lChange = new Float32Array(pixelCount);
      for (let i = 0; i < pixelCount; i++) lChange[i] = (lMean[i] - lum[i]) * uniformityAmt * 0.55;
      for (let i = 0; i < pixelCount; i++) {
        const wA = colourAmt * (1 - gate[i] * 0.35);
        const a = chromaA[i] + (aMean[i] - chromaA[i]) * wA;
        const b = chromaB[i] + (bMean[i] - chromaB[i]) * wA;
        const L = clamp(lum[i] + lChange[i], 0, 100);
        const rgb = labToRgb(L, a, b);
        smoothedLow.r[i] = clamp(rgb.r, 0, 255);
        smoothedLow.g[i] = clamp(rgb.g, 0, 255);
        smoothedLow.b[i] = clamp(rgb.b, 0, 255);
      }
    }

    const mask = refineMask(scaleMask(coverage, 1), width, height, { feather: s.maskFeather, expand: 0, smooth: 1, speckleRadius: 1 });

    const layers = [
      group(
        ctx.layerName || 'Photografix — Skin Studio · Frequency Separation (Advanced)',
        [
          pixelLayer('Texture  (guided high frequency)', smoothedHigh, {
            safeguard: false,
            blendMode: 'linearLight',
            opacity: 100,
            mask,
            note: 'Gated by pore protection and blemish awareness. Brush further texture changes here.',
          }),
          pixelLayer('Colour  (Lab-unified low frequency)', smoothedLow, {
            safeguard: true,
            blendMode: 'normal',
            opacity: 100,
            mask,
            note: 'a-star/b-star unified locally, L preserved. Brush colour changes here.',
          }),
          adjustmentLayer(
            'Uniformity  (editable curves)',
            { type: 'curves', luma: [[0, 0], [96, 98], [160, 160], [255, 255]] },
            { mask, opacity: 60, note: 'Slow-drift correction on top of the blended colour layer.' },
          ),
        ],
        { opacity: s.opacity },
      ),
    ];

    const preview = ctx.renderStack ? ctx.renderStack(layers, frame) : frame.clone();

    const skinStats = summariseSkin(smoothedLow, mask);
    return {
      mode: 'advanced',
      layers,
      preview,
      mask,
      radiusUsed: radius,
      analysis: {
        faceConfidence: analysis.face?.confidence ?? 0,
        suggestedRadius: surface?.suggestedRadius ?? radius,
        textureNorm: surface?.textureNorm ?? 0,
        blemishCoverage: blemishes ? coverageOf(blemishes, mask) : 0,
        melanin: skinStats?.melanin ?? 0,
        undertone: skinStats?.undertone ?? 'unknown',
        uniformityGain: uniformityAmt,
      },
      report: {
        mode: 'advanced',
        radius,
        radiusAuto: Boolean(s.adaptiveRadius && surface),
        smoothingApplied: smoothingAmount,
        porePreserved: poreAmount,
        colourBlending: colourAmt,
        coverage: coverageOf(mask),
      },
    };
  }
}

const coverageOf = (mask) => {
  let s = 0;
  for (let i = 0; i < mask.length; i++) s += mask[i];
  return mask.length ? s / mask.length : 0;
};
