import { clamp, smoothstep, luma } from '../util/math.js';
import { defineSchema } from '../util/params.js';
import { Frame } from '../image/frame.js';
import { lumaArray } from '../analysis/histogram.js';
import { rgbToLab, labToRgb } from '../image/colorspace.js';
import { group, adjustmentLayer, pixelLayer, solidLayer } from '../layers/record.js';
import { intersectMasks, scaleMask, refineMask, tonalMask } from '../masks/masks.js';
import { ProcessingEngine } from './common.js';

/**
 * ColourGradingEngine
 *
 * Stage 5. Grades as a stack of Photoshop adjustment layers (curves, colour
 * balance, selective colour, gradient map) with real masks, so the photographer
 * can tune the grade afterwards instead of accepting a baked look.
 *
 * Grades are authored as parameters, never as copied presets from other software:
 * each look below is built from the primitives and tuned for skin safety first -
 * in a portrait, the skin must survive the grade.
 */

export const GRADE_LOOKS = [
  {
    id: 'none', label: 'No grade (skin-safe neutral)', family: 'neutral',
    description: 'No stylistic grade. Use when the photograph is going to a lab or another retoucher.',
    params: {},
  },
  {
    id: 'photografix-signature', label: 'Photografix Signature', family: 'signature',
    description: 'The house look: deep, clean shadows; rich melanin midtones; gently warmed highlights; protected skin saturation.',
    params: { contrast: 6, shadowTint: [2, 4, 12], midTint: [3, 1, -2], highlightTint: [4, 1, -4], vibrance: 6, saturation: -1, clarity: 4, skinProtect: 85 },
  },
  {
    id: 'photografix-editorial', label: 'Photografix Editorial', family: 'signature',
    description: 'Cooler shadows, neutral skin, slightly desaturated for magazine work.',
    params: { contrast: 8, shadowTint: [-2, 2, 10], midTint: [0, 0, 1], highlightTint: [2, 0, -2], vibrance: 2, saturation: -6, clarity: 6, skinProtect: 90 },
  },
  {
    id: 'cinematic-teal-orange', label: 'Cinematic Teal & Orange', family: 'cinematic',
    description: 'Classic filmic split-tone with skin held orange and shadow held teal. Melanin-aware: skin masks keep the orange from going muddy.',
    params: { contrast: 12, shadowTint: [-8, 2, 14], midTint: [4, 0, -4], highlightTint: [8, 2, -8], vibrance: 8, saturation: 2, clarity: 5, skinProtect: 88 },
  },
  {
    id: 'cinematic-warm-film', label: 'Cinematic Warm Film', family: 'cinematic',
    description: 'Warm midtones, lifted filmic shadows, soft highlight roll-off.',
    params: { contrast: 4, shadowTint: [6, 2, -4], midTint: [5, 2, -3], highlightTint: [6, 3, -5], lift: 3, vibrance: 5, saturation: 0, clarity: 3, skinProtect: 90 },
  },
  {
    id: 'cinematic-cool-noir', label: 'Cinematic Cool Noir', family: 'cinematic',
    description: 'Desaturated, cool grade with deep shadows. Skin is protected from the cool cast.',
    params: { contrast: 16, shadowTint: [-4, 0, 8], midTint: [-1, 0, 3], highlightTint: [0, 1, 4], saturation: -18, vibrance: -4, clarity: 6, skinProtect: 95 },
  },
  {
    id: 'wedding-airy', label: 'Wedding Airy', family: 'wedding',
    description: 'Bright, airy, low-contrast grade for white balance-critical wedding delivery.',
    params: { contrast: -6, lift: 6, shadowTint: [4, 2, 0], midTint: [2, 1, 0], highlightTint: [3, 2, 0], vibrance: 3, saturation: -2, clarity: 2, skinProtect: 92 },
  },
  {
    id: 'wedding-warm-gold', label: 'Wedding Warm Gold', family: 'wedding',
    description: 'Golden hour warmth with preserved highlight detail.',
    params: { contrast: 3, shadowTint: [5, 2, -3], midTint: [6, 2, -4], highlightTint: [8, 4, -6], vibrance: 6, saturation: 1, clarity: 3, skinProtect: 90 },
  },
  {
    id: 'wedding-classic', label: 'Wedding Classic Neutral', family: 'wedding',
    description: 'Neutral, true-to-life wedding grade that survives print.',
    params: { contrast: 5, shadowTint: [1, 1, 1], midTint: [1, 0, 0], highlightTint: [2, 1, 0], vibrance: 2, saturation: 0, clarity: 4, skinProtect: 94 },
  },
  {
    id: 'african-beauty-glow', label: 'African Beauty Glow', family: 'signature',
    description: 'Purpose-built for melanin-rich beauty work: chroma is lifted in the midtones only, highlights stay clean, shadows keep detail.',
    params: { contrast: 5, shadowTint: [3, 1, -1], midTint: [5, 3, -3], highlightTint: [3, 2, 0], vibrance: 10, saturation: 3, clarity: 3, skinProtect: 96, melaninBoost: true },
  },
  {
    id: 'dark-skin-luxury', label: 'Dark Skin Luxury', family: 'signature',
    description: 'Deep, luxurious shadows with a controlled cool separation. No lifting of the base.',
    params: { contrast: 10, shadowTint: [1, 1, 6], midTint: [3, 1, -2], highlightTint: [2, 1, -2], vibrance: 8, saturation: 4, clarity: 5, skinProtect: 96, melaninBoost: true },
  },
];

export const COLOUR_GRADING_SCHEMA = defineSchema([
  { id: 'look', type: 'enum', label: 'Grade', group: 'Grade', options: GRADE_LOOKS.map((l) => ({ value: l.id, label: l.label })), default: 'photografix-signature' },
  { id: 'intensity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Grade intensity', group: 'Grade', default: 75 },
  { id: 'contrast', type: 'range', min: -50, max: 50, step: 1, label: 'Contrast', group: 'Tone', default: 0 },
  { id: 'lift', type: 'range', min: -30, max: 30, step: 1, label: 'Shadow lift', group: 'Tone', default: 0 },
  { id: 'highlights', type: 'range', min: -50, max: 50, step: 1, label: 'Highlight adjustment', group: 'Tone', default: 0 },
  { id: 'shadows', type: 'range', min: -50, max: 50, step: 1, label: 'Shadow adjustment', group: 'Tone', default: 0 },
  { id: 'vibrance', type: 'range', min: -50, max: 50, step: 1, label: 'Vibrance', group: 'Colour', default: 0 },
  { id: 'saturation', type: 'range', min: -50, max: 50, step: 1, label: 'Saturation', group: 'Colour', default: 0 },
  { id: 'clarity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Clarity (local contrast)', group: 'Colour', default: 0 },
  { id: 'temperature', type: 'range', min: -50, max: 50, step: 1, label: 'Temperature', group: 'Colour', default: 0 },
  { id: 'tint', type: 'range', min: -50, max: 50, step: 1, label: 'Tint', group: 'Colour', default: 0 },
  { id: 'skinProtect', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Skin protection', group: 'Safeguards', default: 88, help: 'Holds skin saturation and hue stable through the grade, so a strong look cannot destroy the complexion.' },
  { id: 'gradeSkinToo', type: 'bool', label: 'Apply grade to skin as well', group: 'Safeguards', default: false, help: 'Off by default: the grade is masked off the skin, then a gentle version is applied. On: the grade covers skin fully.' },
  { id: 'opacity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Group opacity', group: 'Output', default: 100 },
  { id: 'maskFeather', type: 'range', min: 0, max: 40, step: 0.5, unit: 'px', label: 'Mask feather', group: 'Output', default: 10 },
]);

export class ColourGradingEngine extends ProcessingEngine {
  constructor() {
    super({ id: 'colour-grading', label: 'Colour Grading', schema: COLOUR_GRADING_SCHEMA });
  }

  process(frame, s, ctx) {
    const analysis = ctx.analysis || ctx.resolver.analyse(frame);
    const { width, height, pixelCount } = frame;
    const look = GRADE_LOOKS.find((l) => l.id === s.look) || GRADE_LOOKS[0];
    const p = look.params || {};
    const k = s.intensity / 100;

    const blend = (base, extra) => (base || 0) + (extra || 0);
    const contrast = blend(p.contrast, s.contrast) * k;
    const lift = blend(p.lift, s.lift) * k;
    const vibrance = blend(p.vibrance, s.vibrance) * k;
    const saturation = blend(p.saturation, s.saturation) * k;
    const clarity = blend(p.clarity, s.clarity) * k;
    const shadowTint = scaleTint(p.shadowTint, k);
    const midTint = scaleTint(p.midTint, k);
    const highlightTint = scaleTint(p.highlightTint, k);
    const temp = s.temperature * 0.35 * k;
    const tint = s.tint * 0.35 * k;

    // Skin mask (for protection) and its inverse (where the grade lives).
    let skinField = analysis.skin;
    if (!skinField) {
      skinField = new Float32Array(pixelCount);
    }
    const skinProtect = (s.skinProtect / 100) * (p.skinProtect ? p.skinProtect / 100 * 1.06 : 1);
    const skinGuard = new Float32Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) skinGuard[i] = s.gradeSkinToo ? 1 : clamp(1 - skinField[i] * clamp(skinProtect));

    // ---- Compose the graded frame (real maths, used for preview + tests) ----
    const graded = frame.clone();
    const lumaField = lumaArray(frame);
    const shadowMask = tonalMask(frame, 'shadows', { softness: 0.4 });
    const midMask = tonalMask(frame, 'midtones', { softness: 0.45 });
    const hiMask = tonalMask(frame, 'highlights', { softness: 0.35 });

    for (let i = 0; i < pixelCount; i++) {
      const lab = rgbToLab(frame.r[i], frame.g[i], frame.b[i]);
      let L = lab.L;
      let a = lab.a;
      let b = lab.b;

      // contrast around the mid grey pivot, S-curve style
      const pivot = 52;
      const contrastFactor = 1 + contrast / 100;
      L = pivot + (L - pivot) * contrastFactor;
      // shadow lift / highlight and shadow adjustment
      const Ln = lumaField[i] / 255;
      L += lift * shadowMask[i] * 0.8;
      L += s.shadows * 0.0015 * shadowMask[i] * k * 40;
      L += s.highlights * 0.0015 * hiMask[i] * k * 40;

      // temperature / tint on the b* and a* axes
      b += temp * (0.6 + midMask[i] * 0.4);
      a += tint * 0.5;

      // split toning
      a += shadowTint[0] * shadowMask[i] * 0.6 + midTint[0] * midMask[i] * 0.55 + highlightTint[0] * hiMask[i] * 0.5;
      b += shadowTint[2] * shadowMask[i] * 0.6 + midTint[2] * midMask[i] * 0.55 + highlightTint[2] * hiMask[i] * 0.5;

      // vibrance: boost low-chroma more than high-chroma, always skin-aware
      const chroma = Math.hypot(a, b);
      const vib = (vibrance / 100) * (1 - clamp(chroma / 60)) * skinGuard[i];
      const satK = 1 + (saturation / 100) * skinGuard[i] + vib;
      a *= satK;
      b *= satK;

      // melanin-aware chroma ceiling for boosted looks
      if (p.melaninBoost) {
        const ceiling = 42 + lab.L * 0.35;
        const c2 = Math.hypot(a, b);
        if (c2 > ceiling) {
          const f = ceiling + (c2 - ceiling) * 0.3;
          a *= f / c2;
          b *= f / c2;
        }
      }

      L = clamp(L, 0, 100);
      const rgb = labToRgb(L, a, b);
      // per-pixel skin guard blends the graded value toward the original
      const g = skinGuard[i];
      graded.r[i] = clamp(frame.r[i] + (rgb.r - frame.r[i]) * g, 0, 255);
      graded.g[i] = clamp(frame.g[i] + (rgb.g - frame.g[i]) * g, 0, 255);
      graded.b[i] = clamp(frame.b[i] + (rgb.b - frame.b[i]) * g, 0, 255);

      // clarity: local contrast on luminance only
      if (clarity > 0 && i > 0) {
        const localMean = (lumaField[Math.max(0, i - 1)] + lumaField[Math.min(pixelCount - 1, i + 1)]) / 2;
        const add = (lumaField[i] - localMean) * (clarity / 100) * 0.35 * g;
        graded.r[i] = clamp(graded.r[i] + add, 0, 255);
        graded.g[i] = clamp(graded.g[i] + add, 0, 255);
        graded.b[i] = clamp(graded.b[i] + add, 0, 255);
      }
    }

    // ---- Layer stack, as real Photoshop adjustment layers ----
    const themeMask = new Float32Array(pixelCount).fill(1);
    for (let i = 0; i < pixelCount; i++) themeMask[i] = skinGuard[i];
    const curvature = clamp(contrast * 0.35, -18, 18);
    const curve = [
      [0, clamp(Math.round(lift * 2), 0, 40)],
      [64, clamp(Math.round(64 + lift * 1.2 - curvature), 0, 255)],
      [128, clamp(Math.round(128 + lift * 0.4), 0, 255)],
      [192, clamp(Math.round(192 + curvature), 0, 255)],
      [255, clamp(Math.round(255 - Math.max(0, s.highlights) * 0.15), 0, 255)],
    ];

    const layers = [
      group(`Photografix — Colour Grading · ${look.label}`, [
        adjustmentLayer('Grade — curves  (contrast / lift)', { type: 'curves', luma: curve, rgb: [[0, 0], [64, 64 + Math.round(curvature * 0.4)], [128, 128], [192, 192 - Math.round(curvature * 0.4)], [255, 255]] }, {
          mask: themeMask,
          opacity: 100,
          note: 'Primary tone curve. Edit directly in Photoshop.',
        }),
        adjustmentLayer('Grade — colour balance  (split tone)', {
          type: 'colourBalance',
          shadows: rgbTint(shadowTint),
          midtones: rgbTint(midTint),
          highlights: rgbTint(highlightTint),
        }, { mask: themeMask, opacity: 100 }),
        adjustmentLayer('Grade — vibrance & saturation', { type: 'vibrance', vibrance: Math.round(vibrance * 1.6), saturation: Math.round(saturation * 0.8) }, {
          mask: (() => {
            const m = new Float32Array(pixelCount);
            for (let i = 0; i < pixelCount; i++) m[i] = clamp(themeMask[i] * (0.4 + 0.6 * (1 - skinField[i] * skinProtect)));
            return m;
          })(),
          opacity: 100,
          note: 'Saturation is held back on skin by a masked vibrance layer.',
        }),
        clarity > 0
          ? adjustmentLayer('Grade — clarity  (high pass on Soft Light)', { type: 'levels', inBlack: 0, inWhite: 255, gamma: 1 + clarity * 0.004, channel: 'rgb' }, {
              mask: themeMask,
              blendMode: 'softLight',
              opacity: 60,
            })
          : null,
        skinProtect > 0 && !s.gradeSkinToo
          ? adjustmentLayer('Skin protection  (saturation hold)', { type: 'hueSaturation', hue: 0, saturation: -Math.round(skinProtect * 4), lightness: 0 }, {
              mask: (() => {
                const m = new Float32Array(pixelCount);
                for (let i = 0; i < pixelCount; i++) m[i] = clamp(skinField[i] * skinProtect * 0.35);
                return m;
              })(),
              opacity: 100,
              note: 'Counterbalances the grade on skin only, so the grade stays strong everywhere else.',
            })
          : null,
      ].filter(Boolean), { opacity: s.opacity }),
    ];

    const preview = ctx.renderStack ? ctx.renderStack(layers, frame) : graded;

    return {
      layers,
      preview,
      graded,
      mask: skinField,
      analysis: {
        look: look.id,
        lookLabel: look.label,
        family: look.family,
        intensity: s.intensity,
        skinProtected: !s.gradeSkinToo,
        contrast,
        vibrance,
        saturation,
        clarity,
        melaninBoost: Boolean(p.melaninBoost),
      },
      report: { look: look.id, layers: layers[0].children.length, skinProtect },
    };
  }
}

const scaleTint = (tint, k) => {
  if (!tint) return [0, 0, 0];
  return tint.map((v) => v * k);
};

const rgbTint = (tint) => [Math.round(tint[0] * 1.4), Math.round(tint[1] * 1.4), Math.round(tint[2] * 1.4)];
