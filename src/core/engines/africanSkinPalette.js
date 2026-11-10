/**
 * AfricanSkinPalette
 *
 * Reference points for the Skin Tone Studio. These are COLOUR-STYLE CATEGORIES,
 * not racial classifications: each entry is a Lab anchor describing what that
 * complexion looks like under neutral studio light, used to (a) recognise which
 * tone range the photograph occupies and (b) give the retoucher a starting point
 * they can then fine-tune with the sliders.
 *
 * Anchors were chosen from the measured Lab statistics of real portrait skin, from
 * deep ebony through to fair, and the melanin bands overlap deliberately - real
 * skin does not sit in clean buckets.
 *
 * `positive` values describe where the tone should move when the retoucher asks for
 * a richer version: the engine only ever moves a modest distance toward the anchor,
 * never repaints.
 */

export const SKIN_TONE_CATEGORIES = [
  {
    id: 'deep-chocolate',
    label: 'Deep Chocolate',
    order: 1,
    lab: { L: 30, a: 16, b: 21 },
    melanin: [0.66, 1.0],
    note: 'Deep, warm brown with chocolate undertone. Keep luminance low; enrich chroma, never lift.',
    richness: { warm: 0.14, saturation: 0.1, highlight: [255, 240, 224] },
  },
  {
    id: 'rich-chocolate',
    label: 'Rich Chocolate',
    order: 2,
    lab: { L: 36, a: 17, b: 23 },
    melanin: [0.6, 0.95],
    note: 'Saturated chocolate with visible warmth in the midtones. The signature Photografix beauty tone.',
    richness: { warm: 0.12, saturation: 0.12, highlight: [255, 242, 226] },
  },
  {
    id: 'dark-ebony',
    label: 'Dark Ebony',
    order: 3,
    lab: { L: 24, a: 11, b: 15 },
    melanin: [0.75, 1.0],
    note: 'The deepest tone. Preserve shadow detail and avoid any global brightening.',
    richness: { warm: 0.08, saturation: 0.08, highlight: [246, 236, 228] },
  },
  {
    id: 'deep-mahogany',
    label: 'Deep Mahogany',
    order: 4,
    lab: { L: 33, a: 20, b: 18 },
    melanin: [0.62, 0.95],
    note: 'Red-leaning deep brown. Needs red control, not yellow, to stay natural.',
    richness: { warm: 0.06, saturation: 0.1, highlight: [255, 236, 220] },
  },
  {
    id: 'warm-dark-brown',
    label: 'Warm Dark Brown',
    order: 5,
    lab: { L: 39, a: 16, b: 24 },
    melanin: [0.55, 0.85],
    note: 'Dark brown with a clear golden warmth.',
    richness: { warm: 0.13, saturation: 0.1, highlight: [255, 243, 225] },
  },
  {
    id: 'natural-dark-brown',
    label: 'Natural Dark Brown',
    order: 6,
    lab: { L: 42, a: 14, b: 21 },
    melanin: [0.5, 0.8],
    note: 'Neutral dark brown. The safest default for consistency work.',
    richness: { warm: 0.08, saturation: 0.07, highlight: [252, 244, 232] },
  },
  {
    id: 'medium-brown',
    label: 'Medium Brown',
    order: 7,
    lab: { L: 48, a: 14, b: 22 },
    melanin: [0.42, 0.72],
    note: 'Classic medium brown. Balances easily against neck and body.',
    richness: { warm: 0.1, saturation: 0.08, highlight: [255, 246, 232] },
  },
  {
    id: 'golden-brown',
    label: 'Golden Brown',
    order: 8,
    lab: { L: 53, a: 12, b: 26 },
    melanin: [0.36, 0.66],
    note: 'Brown with a golden cast. Yellow must be held in check or it turns brassy.',
    richness: { warm: 0.11, saturation: 0.1, highlight: [255, 247, 226] },
  },
  {
    id: 'caramel',
    label: 'Caramel',
    order: 9,
    lab: { L: 58, a: 14, b: 25 },
    melanin: [0.3, 0.6],
    note: 'Warm mid-tone, strongly saturated. Watch the red channel in highlights.',
    richness: { warm: 0.12, saturation: 0.1, highlight: [255, 244, 228] },
  },
  {
    id: 'honey',
    label: 'Honey',
    order: 10,
    lab: { L: 63, a: 12, b: 26 },
    melanin: [0.24, 0.52],
    note: 'Light warm brown with golden highlights. Needs highlight colour care.',
    richness: { warm: 0.1, saturation: 0.09, highlight: [255, 246, 230] },
  },
  {
    id: 'warm-tan',
    label: 'Warm Tan',
    order: 11,
    lab: { L: 68, a: 11, b: 23 },
    melanin: [0.2, 0.45],
    note: 'Tan with visible warmth; easy to over-saturate.',
    richness: { warm: 0.08, saturation: 0.07, highlight: [255, 247, 236] },
  },
  {
    id: 'neutral-medium',
    label: 'Neutral Medium',
    order: 12,
    lab: { L: 72, a: 9, b: 19 },
    melanin: [0.14, 0.36],
    note: 'Neutral medium tone. The reference point for consistency across skin types.',
    richness: { warm: 0.05, saturation: 0.05, highlight: [252, 248, 240] },
  },
  {
    id: 'light-skin',
    label: 'Light Skin',
    order: 13,
    lab: { L: 79, a: 8, b: 16 },
    melanin: [0.05, 0.22],
    note: 'Light tone. Highlight clipping is the main risk.',
    richness: { warm: 0.04, saturation: 0.04, highlight: [253, 250, 244] },
  },
  {
    id: 'fair-skin',
    label: 'Fair Skin',
    order: 14,
    lab: { L: 84, a: 6, b: 14 },
    melanin: [0, 0.15],
    note: 'Fair tone. Redness control matters more than warmth.',
    richness: { warm: 0.03, saturation: 0.03, highlight: [254, 251, 246] },
  },
];

export const SKIN_TONE_STYLES = [
  {
    id: 'neutral',
    label: 'Neutral (no style)',
    description: 'Palette correction only - no stylistic grade.',
    treatment: {},
  },
  {
    id: 'rich-chocolate-glow',
    label: 'Rich Chocolate Glow',
    description: 'Deep, saturated chocolate with a warm, luminous midtone and clean highlights.',
    treatment: { luminance: -2, warmth: 9, saturation: 8, redPct: 3, shadowLift: 4, highlightWarmth: 6, midtoneLift: 2 },
  },
  {
    id: 'warm-mahogany',
    label: 'Warm Mahogany',
    description: 'Red-forward mahogany with controlled yellow and deep, rich shadows.',
    treatment: { luminance: -1, warmth: 4, saturation: 6, redPct: 8, yellowPct: -5, shadowLift: 2, highlightWarmth: 4 },
  },
  {
    id: 'golden-brown-beauty',
    label: 'Golden Brown Beauty',
    description: 'Golden, dimensional beauty tone with soft highlight warmth.',
    treatment: { luminance: 2, warmth: 11, saturation: 7, yellowPct: 3, midtoneLift: 3, highlightWarmth: 8 },
  },
  {
    id: 'deep-ebony-luxury',
    label: 'Deep Ebony Luxury',
    description: 'Ebony with lifted shadow detail and a subtle cool-clean highlight. No brightening of the base.',
    treatment: { luminance: 0, warmth: 3, saturation: 5, shadowLift: 8, highlightCool: 3, midtoneLift: 1 },
  },
  {
    id: 'natural-melanin',
    label: 'Natural Melanin',
    description: 'Protects the subject\'s own tone: minimal chroma change, no brightening, balanced transitions.',
    treatment: { luminance: 0, warmth: 1, saturation: 1, uniformity: 8, shadowLift: 2 },
  },
  {
    id: 'soft-caramel',
    label: 'Soft Caramel',
    description: 'Caramel with softened contrast and a creamy highlight.',
    treatment: { luminance: 4, warmth: 8, saturation: 5, highlightWarmth: 10, midtoneLift: 4, contrast: -6 },
  },
  {
    id: 'neutral-studio-skin',
    label: 'Neutral Studio Skin',
    description: 'Clean studio neutrality: no cast, measured saturation, even transitions.',
    treatment: { luminance: 1, warmth: -2, saturation: 2, uniformity: 12, neutrality: 10 },
  },
  {
    id: 'warm-tan-light',
    label: 'Warm Tan (light tones)',
    description: 'Lighter-skin variant of the warm family, with clipping protection.',
    treatment: { luminance: 2, warmth: 6, saturation: 4, highlightWarmth: 6, highlightProtect: 10 },
  },
  {
    id: 'clean-fair',
    label: 'Clean Fair (light tones)',
    description: 'Fair skin with redness tamed and highlights held back from clipping.',
    treatment: { luminance: 1, redPct: -6, saturation: -2, neutrality: 8, highlightProtect: 12 },
  },
];

/** Nearest palette entry for a measured Lab value. */
export const matchPaletteEntry = (lab) => {
  let best = null;
  let bestDist = Infinity;
  for (const entry of SKIN_TONE_CATEGORIES) {
    const dL = (entry.lab.L - lab.L) * 1.0;
    const da = (entry.lab.a - lab.a) * 1.3;
    const db = (entry.lab.b - lab.b) * 1.3;
    const dist = Math.sqrt(dL * dL + da * da + db * db);
    if (dist < bestDist) {
      bestDist = dist;
      best = { ...entry, distance: dist };
    }
  }
  return best;
};

export const paletteById = (id) => SKIN_TONE_CATEGORIES.find((c) => c.id === id) || null;
export const styleById = (id) => SKIN_TONE_STYLES.find((s) => s.id === id) || SKIN_TONE_STYLES[0];

/**
 * Build a reusable custom preset from palette + treatment (saved by the retoucher).
 * Stored as plain JSON so it can be written to the user's preset file.
 */
export const buildCustomTonePreset = ({ name, paletteId, treatment, sliders }) => ({
  id: `custom-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  label: name,
  paletteId,
  treatment: { ...treatment },
  sliders: { ...sliders },
  createdAt: new Date().toISOString(),
  kind: 'custom-skin-tone',
});

export const validateCustomPreset = (preset) => {
  const errors = [];
  if (!preset || typeof preset !== 'object') return { ok: false, errors: ['preset must be an object'] };
  if (!preset.label) errors.push('label required');
  if (preset.paletteId && !paletteById(preset.paletteId)) errors.push(`unknown palette id ${preset.paletteId}`);
  if (preset.sliders && typeof preset.sliders !== 'object') errors.push('sliders must be an object');
  return { ok: errors.length === 0, errors };
};
