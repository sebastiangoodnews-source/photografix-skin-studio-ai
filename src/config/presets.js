/**
 * Intensity presets shared by every tool.
 *
 * Presets are parameter overlays, never separate code paths: a preset value is
 * the same slider the retoucher can move afterwards, which is what makes
 * "adjust strength after the operation" possible on the non-destructive layer.
 */

export const INTENSITY_STEPS = {
  'very-subtle': 0.18,
  subtle: 0.3,
  natural: 0.45,
  medium: 0.62,
  strong: 0.82,
  custom: null,
};

export const INTENSITY_OPTIONS = [
  { value: 'very-subtle', label: 'Very subtle' },
  { value: 'subtle', label: 'Subtle' },
  { value: 'natural', label: 'Natural' },
  { value: 'medium', label: 'Medium' },
  { value: 'strong', label: 'Strong' },
  { value: 'custom', label: 'Custom' },
];

export const SCULPT_PRESETS = [
  { value: 'subtle', label: 'Subtle sculpt' },
  { value: 'natural', label: 'Natural sculpt' },
  { value: 'dramatic', label: 'Dramatic sculpt' },
  { value: 'custom', label: 'Custom' },
];

export const SCULPT_PRESET_VALUES = {
  subtle: { sculptStrength: 16, highlightStrength: 20, shadowStrength: 14, highlightSoftness: 36, shadowSoftness: 42, feathering: 38, maskIntensity: 70 },
  natural: { sculptStrength: 34, highlightStrength: 40, shadowStrength: 30, highlightSoftness: 26, shadowSoftness: 32, feathering: 30, maskIntensity: 82 },
  dramatic: { sculptStrength: 52, highlightStrength: 62, shadowStrength: 50, highlightSoftness: 18, shadowSoftness: 22, feathering: 22, maskIntensity: 92 },
  custom: null,
};

export const GLOSS_PRESETS = [
  { value: 'subtle-glow', label: 'Subtle glow' },
  { value: 'natural-gloss', label: 'Natural gloss' },
  { value: 'beauty-gloss', label: 'Beauty gloss' },
  { value: 'premium-gloss', label: 'Premium gloss' },
  { value: 'custom', label: 'Custom' },
];

export const GLOSS_PRESET_VALUES = {
  'subtle-glow': { glowIntensity: 14, highlightIntensity: 18, highlightSpread: 34, highlightSoftness: 40, highlightOpacity: 55, glossSmoothness: 45 },
  'natural-gloss': { glowIntensity: 24, highlightIntensity: 30, highlightSpread: 30, highlightSoftness: 34, highlightOpacity: 68, glossSmoothness: 55 },
  'beauty-gloss': { glowIntensity: 34, highlightIntensity: 42, highlightSpread: 26, highlightSoftness: 28, highlightOpacity: 78, glossSmoothness: 65 },
  'premium-gloss': { glowIntensity: 46, highlightIntensity: 55, highlightSpread: 22, highlightSoftness: 22, highlightOpacity: 86, glossSmoothness: 75 },
  custom: null,
};

export const FS_MODE_INFO = {
  normal: {
    id: 'normal',
    label: 'Normal',
    tagline: 'Conventional frequency separation for brush-led retouching',
    description:
      'Splits the photograph into a low-frequency colour layer and a high-frequency texture layer over a live grouped pair. ' +
      'You retouch colour on the low layer with the mixer or healing brush and texture on the high layer, exactly as in a hand-built ' +
      'Photoshop frequency separation. Layer opacity, visibility and blur radius stay adjustable, so the split is never baked in.',
    bestFor: 'Portraits where you want to drive the retouching yourself with brushes.',
  },
  advanced: {
    id: 'advanced',
    label: 'Advanced',
    tagline: 'Guided separation with skin-aware smoothing',
    description:
      'Adds adaptive radius selection, melanin-aware skin detection and a texture gate: smoothing is applied only where skin is smooth ' +
      'enough to accept it, while pores, lashes and lip texture are preserved. Colour is blended locally in Lab rather than globally, ' +
      'so uneven tone evens out without flattening the modelling of the face.',
    bestFor: 'Editorial and studio portraits that need speed without a plastic finish.',
  },
  professional: {
    id: 'professional',
    label: 'Professional',
    tagline: 'Multi-scale beauty separation, quality first',
    description:
      'Three frequency bands (form, structure, pore-level texture) with per-region treatment for forehead, cheeks, nose, under-eye, ' +
      'chin and jawline. Blemish-aware isolation, local texture restoration and adaptive colour transition correction rebuild ' +
      'natural pore structure instead of blurring it away. The default is deliberately conservative: refine, then increase.',
    bestFor: 'Commercial beauty and portrait delivery where skin realism is non-negotiable.',
  },
};

export const STAGE_ORDER = [
  {
    id: 'frequency',
    stage: 1,
    label: 'Frequency Separation',
    description: 'Separate texture from colour and even out the surface.',
  },
  {
    id: 'micro-dodge-burn',
    stage: 2,
    label: 'Micro Dodge & Burn',
    description: 'Correct small tonal distractions on face and body.',
  },
  {
    id: 'sculpt-dodge-burn',
    stage: 3,
    label: 'Sculpt Dodge & Burn',
    description: 'Shape form, dimension and contour with light.',
  },
  {
    id: 'skin-tone',
    stage: 4,
    label: 'African Skin Tone Studio',
    description: 'Preserve melanin, refine complexion, match face to body.',
  },
  {
    id: 'colour-grading',
    stage: 5,
    label: 'Colour Grading',
    description: 'Cinematic, wedding and Photografix signature grades.',
  },
  {
    id: 'glossy-skin',
    stage: 6,
    label: 'Photografix Glossy Skin',
    description: 'Intelligent highlight, glow, lip and contour finishing.',
  },
  {
    id: 'review',
    stage: 7,
    label: 'Final Review',
    description: 'Compare, tune opacity, refine masks, export.',
  },
];
