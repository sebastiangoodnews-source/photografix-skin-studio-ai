import { clamp, smoothstep } from '../util/math.js';
import { defineSchema } from '../util/params.js';
import { Frame } from '../image/frame.js';
import { blurFrame, blurChannelArray } from '../image/filters.js';
import { lumaArray } from '../analysis/histogram.js';
import { summariseSkin, skinProbabilityField } from '../analysis/skin.js';
import { analyseFaceSurface } from '../segmentation/face.js';
import {
  unionMasks,
  intersectMasks,
  refineMask,
  tonalMask,
  detailProtectionMask,
  edgeAwareRefine,
  scaleMask,
} from '../masks/masks.js';
import { featherMask } from '../analysis/regions.js';
import { group, pixelLayer, adjustmentLayer, solidLayer } from '../layers/record.js';
import {
  ProcessingEngine,
  splitFrequencies,
  textureGate,
  detectBlemishes,
  blendWithMask,
  flattenIllumination,
} from './common.js';
import { rgbToLab, labToRgb } from '../image/colorspace.js';

/**
 * FrequencySeparationEngine - MODE 1: Normal frequency separation.
 *
 * Produces the conventional, fully brushable Photoshop frequency separation:
 *
 *   Photografix Skin Studio — Frequency Separation (Normal)
 *     ├─ Texture  (Linear Light, High-pass detail)      <- retouch texture here
 *     ├─ Colour   (Normal, Low frequency)               <- retouch colour here
 *
 * The engine does the split; the retoucher does the retouching with brushes,
 * healing, clone and mixer brushes. Nothing is auto-smoothed in this mode, which
 * is exactly what "normal frequency separation" should mean.
 */

export const NORMAL_FS_SCHEMA = defineSchema([
  {
    id: 'blurRadius',
    type: 'range',
    min: 1,
    max: 40,
    step: 0.5,
    unit: 'px',
    label: 'Gaussian blur radius',
    group: 'Separation',
    default: 8,
    help: 'Low-frequency radius. Match it to the size of the tone variation you want to move to the colour layer, roughly the pore-to-pore distance at 100%.',
  },
  {
    id: 'detailScale',
    type: 'range',
    min: 0.25,
    max: 2,
    step: 0.05,
    label: 'Texture amount',
    group: 'Separation',
    default: 1,
    help: 'Gain on the high-frequency layer. 1.0 reconstructs the original perfectly; higher values exaggerate texture for a stronger retouching signal.',
  },
  {
    id: 'mode',
    type: 'enum',
    label: 'High-pass mode',
    group: 'Separation',
    options: [
      { value: 'linearLight', label: 'Linear Light (lossless)' },
      { value: 'overlay', label: 'Overlay (classic high-pass)' },
    ],
    default: 'linearLight',
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
    id: 'restrictToSkin',
    type: 'bool',
    label: 'Limit to detected skin',
    group: 'Region',
    default: true,
    help: 'Keeps the separation masks off hair, clothing and background.',
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
  {
    id: 'autoAdaptRadius',
    type: 'bool',
    label: 'Suggest radius from analysis',
    group: 'Separation',
    default: true,
    advanced: true,
  },
  {
    id: 'textureOpacity',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Texture layer opacity',
    group: 'Output',
    default: 100,
  },
  {
    id: 'colourOpacity',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Colour layer opacity',
    group: 'Output',
    default: 100,
  },
  {
    id: 'includeCurves',
    type: 'bool',
    label: 'Add editable tone curves',
    group: 'Output',
    default: true,
    help: 'Adds a curves adjustment inside the group so overall tone can be tuned after the split.',
  },
]);

export class FrequencySeparationEngine extends ProcessingEngine {
  constructor() {
    super({ id: 'frequency-separation-normal', label: 'Frequency Separation — Normal', schema: NORMAL_FS_SCHEMA });
  }

  process(frame, s, ctx) {
    const analysis = ctx.analysis || ctx.resolver?.analyse(frame);
    const selectionMask = ctx.resolver.selectionMask(analysis, { region: s.region }, {
      feather: s.maskFeather,
      customMask: ctx.customMask,
      customRect: ctx.customRect,
    });
    let coverage = selectionMask;
    if (s.restrictToSkin) coverage = intersectMasks([coverage, analysis.skin]);
    coverage = refineMask(coverage, frame.width, frame.height, { feather: s.maskFeather, expand: 0, smooth: 1, speckleRadius: 1 });

    const surface = analysis.face?.found ? analyseFaceSurface(frame, analysis.face) : null;
    const radius = s.autoAdaptRadius && surface ? surface.suggestedRadius : s.blurRadius;

    const { low, high } = splitFrequencies(frame, radius, {
      mode: s.mode === 'overlay' ? 'overlay' : 'linearLight',
      detailScale: s.detailScale,
    });

    const layers = [
      group(ctx.layerName || 'Photografix — Skin Studio · Frequency Separation (Normal)', [
        pixelLayer('Texture  (high frequency)', high, {
          safeguard: false,
          blendMode: s.mode === 'overlay' ? 'overlay' : 'linearLight',
          opacity: s.textureOpacity,
          mask: coverage,
          note: 'Retouch texture here: healing brush, clone stamp, micro dodge & burn.',
        }),
        pixelLayer('Colour  (low frequency)', low, {
          safeguard: true,
          blendMode: 'normal',
          opacity: s.colourOpacity,
          mask: coverage,
          note: 'Retouch colour and tone here: mixer brush, soft light brush, local colour blends.',
        }),
        s.includeCurves
          ? adjustmentLayer(
              'Tone  (editable curves)',
              { type: 'curves', luma: [[0, 0], [64, 66], [128, 130], [192, 192], [255, 255]] },
              { mask: scaleMask(coverage, 1), note: 'Neutral curves for post-split tone tuning. Double-click to edit in Photoshop.' },
            )
          : null,
      ].filter(Boolean)),
    ];

    const preview = ctx.renderStack ? ctx.renderStack(layers, frame) : frame.clone();

    return {
      mode: 'normal',
      layers,
      preview,
      mask: coverage,
      radiusUsed: radius,
      analysis: {
        faceConfidence: analysis.face?.confidence ?? 0,
        suggestedRadius: surface?.suggestedRadius ?? s.blurRadius,
        textureNorm: surface?.textureNorm ?? 0,
        skinCoverage: summariseSkin(frame, coverage)?.coverage ?? 0,
      },
      report: {
        mode: 'normal',
        radius,
        autoAdapted: Boolean(s.autoAdaptRadius && surface),
        highPassMode: s.mode,
        coverage: maskCoverage(coverage),
      },
    };
  }
}

const maskCoverage = (m) => {
  let s = 0;
  for (let i = 0; i < m.length; i++) s += m[i];
  return m.length ? s / m.length : 0;
};
