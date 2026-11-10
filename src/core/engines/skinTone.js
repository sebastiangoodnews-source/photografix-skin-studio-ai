import { clamp, smoothstep, luma } from '../util/math.js';
import { defineSchema } from '../util/params.js';
import { Frame } from '../image/frame.js';
import { blurChannelArray, blurFrame } from '../image/filters.js';
import { lumaArray } from '../analysis/histogram.js';
import { summariseSkin, skinMask } from '../analysis/skin.js';
import { rgbToLab, labToRgb, rgbToLch, lchToLab, lchToRgb } from '../image/colorspace.js';
import { unionMasks, intersectMasks, refineMask, tonalMask, edgeAwareRefine, scaleMask } from '../masks/masks.js';
import { featherMask } from '../analysis/regions.js';
import { group, pixelLayer, adjustmentLayer, solidLayer } from '../layers/record.js';
import { ProcessingEngine, medianApprox } from './common.js';
import { SKIN_TONE_CATEGORIES, SKIN_TONE_STYLES, matchPaletteEntry, paletteById, styleById } from './africanSkinPalette.js';

/**
 * Maximum total L* a single run may ADD to a fully melanin-rich pixel.
 *
 * Calibrated so one run stays inside the Final Review's default melanin allowance
 * (4 L*) with room for the styles above and below it, while fair skin (melanin
 * near 0) is free to move by the full amount. Darkening is never capped here - the
 * rule is about not lightening deep skin.
 */
export const LUMINANCE_CAP_MAX = 5.5;

/**
 * SkinToneEngine
 *
 * The signature Photografix capability. Principles encoded in the maths:
 *
 *  1. MELANIN IS PROTECTED. Luminance is never lifted globally. The engine only
 *     redistributes tone inside the subject's existing range (shadow lift is
 *     bounded by the measured range and masked to shadows), and any requested
 *     brightening above the protection threshold is clamped.
 *  2. NO FORCED ORANGE. Warmth is applied on the Lab b* axis with a hard
 *     saturation ceiling; a-star/b-star are also constrained so the result cannot drift
 *     into the muddy-grey or artificially-yellow zones.
 *  3. DEEP SKIN GETS MORE CHROMA CARE, NOT MORE LIGHT. The chroma budget scales
 *     with the melanin index, while the luminance budget scales down with it.
 *  4. FACE MATCHES NECK AND BODY. Face/neck and face/body colour deltas are
 *     measured and corrected toward the body, which is the direction that looks
 *     natural in 99% of portraits (the face is usually closer to the key light and
 *     drifts warm).
 *  5. NON-DESTRUCTIVE. Output is a group of masked solid-adjustment layers, so the
 *     retoucher can dial hue/saturation/lightness afterwards with a real mask.
 */

export const SKIN_TONE_SCHEMA = defineSchema([
  { id: 'palette', type: 'enum', label: 'Skin tone category', group: 'Palette', options: SKIN_TONE_CATEGORIES.map((c) => ({ value: c.id, label: c.label })), default: 'rich-chocolate', help: 'A colour-style category describing where the tone should sit. Auto-match reads the photograph; choosing a category overrides it.' },
  { id: 'autoMatch', type: 'bool', label: 'Auto-match category from photograph', group: 'Palette', default: true },
  { id: 'style', type: 'enum', label: 'Skin style', group: 'Style', options: SKIN_TONE_STYLES.map((s) => ({ value: s.id, label: s.label })), default: 'natural-melanin' },
  { id: 'hue', type: 'range', min: -30, max: 30, step: 1, label: 'Hue', group: 'Colour', default: 0 },
  { id: 'saturation', type: 'range', min: -50, max: 50, step: 1, label: 'Saturation', group: 'Colour', default: 0 },
  { id: 'luminance', type: 'range', min: -30, max: 30, step: 1, label: 'Luminance', group: 'Colour', default: 0, help: 'Bounded by melanin protection: deep skin cannot be washed out by this slider.' },
  { id: 'warmth', type: 'range', min: -30, max: 30, step: 1, label: 'Warmth', group: 'Colour', default: 0 },
  { id: 'redness', type: 'range', min: -30, max: 30, step: 1, label: 'Redness', group: 'Balance', default: 0 },
  { id: 'yellow', type: 'range', min: -30, max: 30, step: 1, label: 'Yellow balance', group: 'Balance', default: 0 },
  { id: 'green', type: 'range', min: -30, max: 30, step: 1, label: 'Green balance', group: 'Balance', default: 0 },
  { id: 'orange', type: 'range', min: -30, max: 30, step: 1, label: 'Orange balance', group: 'Balance', default: 0 },
  { id: 'highlightColour', type: 'colour', label: 'Highlight colour', group: 'Tonal colour', default: [255, 244, 230], help: 'Tint applied only where skin is in the highlights.' },
  { id: 'midtoneColour', type: 'colour', label: 'Midtone colour', group: 'Tonal colour', default: [132, 88, 62] },
  { id: 'shadowColour', type: 'colour', label: 'Shadow colour', group: 'Tonal colour', default: [58, 34, 24] },
  { id: 'highlightTint', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Highlight tint amount', group: 'Tonal colour', default: 12 },
  { id: 'midtoneTint', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Midtone tint amount', group: 'Tonal colour', default: 8 },
  { id: 'shadowTint', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Shadow tint amount', group: 'Tonal colour', default: 10 },
  { id: 'faceNeckMatch', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Face-to-neck matching', group: 'Matching', default: 50 },
  { id: 'faceBodyMatch', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Face-to-body matching', group: 'Matching', default: 35 },
  { id: 'referenceMatch', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Reference matching', group: 'Matching', default: 0, help: 'Pulls skin toward a reference Lab value captured from a sample point in the photograph.' },
  { id: 'uniformity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Complexion refinement', group: 'Matching', default: 30 },
  { id: 'protectMelanin', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Melanin protection', group: 'Safeguards', default: 90, help: 'Photografix does not automatically brighten deep skin. Lowering this is possible but the engine still clamps the total lift.' },
  { id: 'protectHighlights', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Highlight protection', group: 'Safeguards', default: 85 },
  { id: 'strength', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Overall strength', group: 'Output', default: 70 },
  { id: 'opacity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Group opacity', group: 'Output', default: 100 },
  { id: 'region', type: 'enum', label: 'Processing region', group: 'Region', options: [
    { value: 'face', label: 'Face' },
    { value: 'neck', label: 'Neck' },
    { value: 'chest', label: 'Chest' },
    { value: 'arms', label: 'Arms' },
    { value: 'legs', label: 'Legs' },
    { value: 'fullBody', label: 'Full body' },
    { value: 'custom', label: 'Custom selection' },
  ], default: 'fullBody' },
  { id: 'maskFeather', type: 'range', min: 0, max: 30, step: 0.5, unit: 'px', label: 'Mask feather', group: 'Region', default: 8 },
]);

export class SkinToneEngine extends ProcessingEngine {
  constructor() {
    super({ id: 'skin-tone', label: 'African Skin Tone Studio', schema: SKIN_TONE_SCHEMA });
  }

  process(frame, s, ctx) {
    const analysis = ctx.analysis || ctx.resolver.analyse(frame);
    const { width, height, pixelCount } = frame;

    const regionMask = ctx.resolver.selectionMask(analysis, { region: s.region }, {
      feather: s.maskFeather,
      customMask: ctx.customMask,
      customRect: ctx.customRect,
    });
    let mask = intersectMasks([regionMask, analysis.skin]);
    mask = edgeAwareRefine(mask, analysis.frame, 3, 0.002);
    mask = refineMask(mask, width, height, { feather: s.maskFeather, expand: 0, smooth: 1, speckleRadius: 1 });

    const measured = summariseSkin(frame, mask) || {
      lab: { L: 50, a: 14, b: 20 },
      melanin: 0.5,
      chroma: 24,
      undertone: 'orange',
      lumaMedian: 120,
      lumaP10: 60,
      lumaP90: 180,
    };
    const category = s.autoMatch ? matchPaletteEntry(measured.lab) : paletteById(s.palette);
    const style = styleById(s.style);
    const treatment = resolveTreatment(style, category, s);

    const melanin = measured.melanin;
    const protect = s.protectMelanin / 100;
    // Luminance budget shrinks as melanin rises: at melanin 1.0 a +30 request may
    // only realise a few levels. This is the core "do not brighten deep skin" rule.
    const luminanceBudget = (1 - melanin * 0.85) * (1 - protect * 0.6) * 30;
    const chromaBudget = 14 + melanin * 22;

    const lum = lumaArray(frame);
    const shadows = tonalMask(frame, 'shadows', { softness: 0.4 });
    const midtones = tonalMask(frame, 'midtones', { softness: 0.45 });
    const highlights = tonalMask(frame, 'highlights', { softness: 0.35 });
    const detailGuardBase = 1;

    const strength = clamp(s.strength / 100);
    const featureProtect = blurChannelArray(highlights, width, height, 1.5);
    const highlightProtect = s.protectHighlights / 100;

    // Per-pixel Lab work
    const out = frame.clone();
    const deltaField = { L: new Float32Array(pixelCount), a: new Float32Array(pixelCount), b: new Float32Array(pixelCount) };
    const lumOut = new Float32Array(pixelCount);

    const targetLab = referenceTarget(s, treatment, category, measured, ctx);

    for (let i = 0; i < pixelCount; i++) {
      const m = mask[i];
      if (m <= 0.002) {
        lumOut[i] = lum[i];
        continue;
      }
      const lab = rgbToLab(frame.r[i], frame.g[i], frame.b[i]);
      const lch = rgbToLch(frame.r[i], frame.g[i], frame.b[i]);

      // --- 1. palette anchoring: nudge toward the category, never snap to it ---
      const anchorW = 0.22 * strength * (s.autoMatch ? 1 : 0.85);
      let L = lab.L + (category.lab.L - lab.L) * anchorW * 0.35;
      let a = lab.a + (category.lab.a - lab.a) * anchorW;
      let b = lab.b + (category.lab.b - lab.b) * anchorW;

      // --- 2. style treatment ---
      L += treatment.luminance * 0.18 * strength * (1 - melanin * 0.8);
      // warmth on b*, scaled by the chroma budget and melanin-aware head room
      const warmthDelta = (treatment.warmth + s.warmth) * 0.16 * strength;
      b += warmthDelta;
      // balance axes: redness moves a*, yellow/orange move b*, green pulls a* down
      a += (s.redness * 0.14 + treatment.redPct * 0.1 - s.green * 0.1) * strength;
      b += (s.yellow * 0.14 + s.orange * 0.12 + treatment.yellowPct * 0.1 + treatment.orangePct * 0.1) * strength;

      // hue rotation around L*
      const hueShift = (s.hue + treatment.hue) * strength;
      if (hueShift !== 0) {
        const rotated = lchToLab(lch.L, lch.C, lch.H + hueShift);
        a = a * 0.35 + rotated.a * 0.65 * (1 + treatment.saturation * 0.004);
        b = b * 0.35 + rotated.b * 0.65 * (1 + treatment.saturation * 0.004);
      }

      // saturation with melanin-aware ceiling: deep skin may gain chroma but not
      // beyond a believable amount for its luminance
      const satK = 1 + ((s.saturation + treatment.saturation) / 100) * strength;
      let C = Math.hypot(a, b) * satK;
      const chromaCeiling = chromaBudget + (100 - L) * 0.25;
      if (C > chromaCeiling) C = chromaCeiling + (C - chromaCeiling) * 0.25;
      if (C < 2.2) C = 2.2 + (2.2 - C) * 0.4; // avoid dead grey skin
      const H = Math.atan2(b, a);
      a = C * Math.cos(H);
      b = C * Math.sin(H);

      // --- 3. luminance: bounded, and the TOTAL lift is capped ---
      // Four things can raise L* here: the palette anchor (above), the requested
      // slider, the style's own luminance, and the style's shadow lift. Each used to be
      // bounded on its own, which is not the same thing - their sum could still walk
      // deep skin upward by several levels per run, and a multi-stage pass compounds it.
      // So the total added lightness is capped, and the cap tightens as melanin rises,
      // because "deep skin is never brightened" is the rule this studio exists to
      // enforce. The reviewer measures exactly this (median L* before/after) in stage 7.
      const totalCap = Math.max(0, LUMINANCE_CAP_MAX * (1 - melanin));
      if (L > lab.L) L = lab.L + Math.min(L - lab.L, totalCap);
      const requestedLift = (s.luminance + treatment.luminance * 0.5) * strength;
      let lift = requestedLift;
      if (lift > 0) lift = Math.min(lift, luminanceBudget * (1 - melanin * 0.5));
      // shadow lift helps deep skin read detail without raising the base
      const shadowLift = (treatment.shadowLift || 0) * strength * shadows[i] * (0.4 + melanin * 0.6);
      const highlightLift = (treatment.midtoneLift || 0) * strength * midtones[i] * 0.4;
      const wanted = lift * 0.55 + shadowLift + highlightLift;
      const budgetLeft = Math.max(0, totalCap - Math.max(0, L - lab.L));
      L += Math.min(wanted, budgetLeft);
      L = clamp(L, 0, 100);

      // --- 4. reference match (optional) ---
      if (targetLab && s.referenceMatch > 0) {
        const w = (s.referenceMatch / 100) * strength;
        L += (targetLab.L - L) * w * 0.6;
        a += (targetLab.a - a) * w * 0.6;
        b += (targetLab.b - b) * w * 0.6;
      }

      const rgb = labToRgb(L, a, b);
      let r = clamp(rgb.r, 0, 255);
      let g = clamp(rgb.g, 0, 255);
      let bl = clamp(rgb.b, 0, 255);

      // --- 5. tonal tint (highlight / midtone / shadow colour) ---
      // Tonal tint: each range pulls the channel toward its target colour by a
      // small weight (a lerp, never an accumulation of the base value).
      const hiW = (s.highlightTint / 100) * highlights[i] * strength * 0.55;
      const midW = (s.midtoneTint / 100) * midtones[i] * strength * 0.4;
      const shW = (s.shadowTint / 100) * shadows[i] * strength * 0.45;
      r = tintChannel(r, s.highlightColour[0], hiW);
      r = tintChannel(r, s.midtoneColour[0], midW);
      r = tintChannel(r, s.shadowColour[0], shW);
      g = tintChannel(g, s.highlightColour[1], hiW);
      g = tintChannel(g, s.midtoneColour[1], midW);
      g = tintChannel(g, s.shadowColour[1], shW);
      bl = tintChannel(bl, s.highlightColour[2], hiW);
      bl = tintChannel(bl, s.midtoneColour[2], midW);
      bl = tintChannel(bl, s.shadowColour[2], shW);

      // --- 6. highlight clipping protection ---
      const L0 = lum[i];
      const L1 = luma(r, g, bl);
      if (L1 > L0) {
        const headroom = Math.max(0, 255 - L0) / 255;
        const allowed = L0 + (L1 - L0) * clamp(headroom * 2.2 + (1 - highlightProtect) * 0.6 + 0.25);
        if (L1 > allowed && L1 > 1e-6) {
          const k = allowed / L1;
          r *= k;
          g *= k;
          bl *= k;
        }
      }

      const blend = m * detailGuardBase;
      out.r[i] = frame.r[i] + (r - frame.r[i]) * blend;
      out.g[i] = frame.g[i] + (g - frame.g[i]) * blend;
      out.b[i] = frame.b[i] + (bl - frame.b[i]) * blend;
      lumOut[i] = luma(out.r[i], out.g[i], out.b[i]);
      deltaField.L[i] = L - lab.L;
      deltaField.a[i] = a - lab.a;
      deltaField.b[i] = b - lab.b;
    }

    // --- 7. complexion uniformity (slow drift only, structure safe) ---
    let finalFrame = out;
    const uniformity = (s.uniformity / 100) * strength;
    if (uniformity > 0.01) {
      finalFrame = this.refineUniformity(out, mask, uniformity, width, height);
    }

    // --- 8. face-to-neck / face-to-body matching ---
    const matching = this.matchFaceToBody(finalFrame, analysis, s, mask, width, height, strength, chromaBudget);

    const layers = this.buildLayers(frame, finalFrame, mask, s, analysis, {
      category,
      style,
      measured,
      treatment,
      matching,
      melanin,
    });

    const preview = ctx.renderStack ? ctx.renderStack(layers, frame) : finalFrame;

    return {
      layers,
      preview,
      mask,
      corrected: finalFrame,
      analysis: {
        measuredTone: measured.lab,
        measuredMelanin: melanin,
        measuredUndertone: measured.undertone,
        matchedCategory: category.id,
        matchedCategoryLabel: category.label,
        matchDistance: category.distance ?? 0,
        style: style.id,
        luminanceBudget,
        chromaBudget,
        matching,
        deltaStats: {
          meanL: meanAbs(deltaField.L, mask),
          meanA: meanAbs(deltaField.a, mask),
          meanB: meanAbs(deltaField.b, mask),
        },
      },
      report: {
        category: category.id,
        style: style.id,
        melanin,
        luminanceBudget: Math.round(luminanceBudget * 10) / 10,
        strength,
        faceNeckMatch: s.faceNeckMatch,
        faceBodyMatch: s.faceBodyMatch,
      },
    };
  }

  refineUniformity(frame, mask, amount, width, height) {
    const n = frame.pixelCount;
    const L = new Float32Array(n);
    const A = new Float32Array(n);
    const B = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lab = rgbToLab(frame.r[i], frame.g[i], frame.b[i]);
      L[i] = lab.L;
      A[i] = lab.a;
      B[i] = lab.b;
    }
    const radius = Math.max(6, Math.round(Math.min(width, height) * 0.04));
    const Ls = blurChannelArray(L, width, height, radius);
    const As = blurChannelArray(A, width, height, radius);
    const Bs = blurChannelArray(B, width, height, radius);
    const out = frame.clone();
    for (let i = 0; i < n; i++) {
      const w = amount * mask[i];
      if (w <= 0.001) continue;
      // only correct slow drift: keep >60% of the local deviation as intended tone
      const dl = (Ls[i] - L[i]) * w * 0.5;
      const da = (As[i] - A[i]) * w * 0.45;
      const db = (Bs[i] - B[i]) * w * 0.45;
      const rgb = labToRgb(clamp(L[i] + dl, 0, 100), A[i] + da, B[i] + db);
      out.r[i] = clamp(rgb.r, 0, 255);
      out.g[i] = clamp(rgb.g, 0, 255);
      out.b[i] = clamp(rgb.b, 0, 255);
    }
    return out;
  }

  matchFaceToBody(frame, analysis, s, skinMaskField, width, height, strength, chromaBudget) {
    const zones = analysis.body?.zones;
    const faceMask = analysis.face?.found ? analysis.regions.face || null : null;
    const result = { faceNeckApplied: 0, faceBodyApplied: 0, faceNeckDelta: null, faceBodyDelta: null, targetLab: null };
    if (!analysis.face?.found || !zones) return result;

    const faceRegionMask = analysis.regions.face;
    if (!faceRegionMask) return result;
    const faceStats = summariseSkin(frame, faceRegionMask);
    const neckMask = zones.neck;
    const bodyMask = unionMasks([zones.neck, zones.chest, zones.arms, zones.legs].filter(Boolean));
    const neckStats = neckMask ? summariseSkin(frame, neckMask) : null;
    const bodyStats = bodyMask ? summariseSkin(frame, bodyMask) : null;
    if (!faceStats) return result;

    // Reference: the body is the anchor (neck first, then overall body).
    const anchorStats = neckStats && neckStats.pixelWeight > width * height * 0.004
      ? neckStats
      : bodyStats && bodyStats.pixelWeight > width * height * 0.004
        ? bodyStats
        : null;
    if (!anchorStats) return result;

    const delta = {
      L: anchorStats.lab.L - faceStats.lab.L,
      a: anchorStats.lab.a - faceStats.lab.a,
      b: anchorStats.lab.b - faceStats.lab.b,
    };
    result.faceNeckDelta = delta;
    result.targetLab = anchorStats.lab;

    const neckW = (s.faceNeckMatch / 100) * strength;
    const bodyW = (s.faceBodyMatch / 100) * strength;
    if (neckW <= 0.001 && bodyW <= 0.001) return result;

    // Apply the anchor colour to the face, weighted by the match sliders. Only the
    // difference is corrected, bounded, and never a luminance lift beyond budget.
    const faceOut = frame;
    const applyMask = faceRegionMask;
    // A face/body match corrects COLOUR drift; it must never brighten deep skin,
    // so the luminance leg is asymmetric and small.
    const clampL = clamp(delta.L, -6, 3);
    const clampA = clamp(delta.a, -6, 6);
    const clampB = clamp(delta.b, -8, 8);
    for (let i = 0; i < width * height; i++) {
      const w = applyMask[i] * skinMaskField[i];
      if (w <= 0.01) continue;
      const lab = rgbToLab(faceOut.r[i], faceOut.g[i], faceOut.b[i]);
      const nL = lab.L + clampL * neckW * w;
      const nA = lab.a + clampA * neckW * w;
      const nB = lab.b + clampB * neckW * w;
      // second pass toward the overall body (usually softer, broader correction)
      let L = nL;
      let A = nA;
      let B = nB;
      if (bodyW > 0.001 && bodyStats) {
        L += (bodyStats.lab.L - lab.L) * bodyW * w * 0.4;
        A += (bodyStats.lab.a - lab.a) * bodyW * w * 0.4;
        B += (bodyStats.lab.b - lab.b) * bodyW * w * 0.4;
      }
      const rgb = labToRgb(clamp(L, 0, 100), A, B);
      faceOut.r[i] = clamp(rgb.r, 0, 255);
      faceOut.g[i] = clamp(rgb.g, 0, 255);
      faceOut.b[i] = clamp(rgb.b, 0, 255);
    }
    result.faceNeckApplied = neckW;
    result.faceBodyApplied = bodyW;
    return result;
  }

  buildLayers(frame, corrected, mask, s, analysis, meta) {
    const { category, style, measured, matching } = meta;
    const shift = diffLayers(frame, corrected, mask);
    const groupName = `Photografix — Skin Studio · African Skin Tone Studio`;

    const children = [
      pixelLayer('Skin tone  (corrected)', corrected, {
        safeguard: true,
        blendMode: 'normal',
        opacity: 100,
        mask,
        note: `Category: ${category.label} · Style: ${style.label}. Mask is editable; paint to extend or restrict the correction.`,
      }),
      adjustmentLayer(
        'Tone polish  (hue/saturation)',
        { type: 'hueSaturation', hue: 0, saturation: clamp((s.saturation + (style.treatment?.saturation || 0)) * 0.35, -40, 40), lightness: 0 },
        { mask: scaleMask(mask, 0.85), opacity: 55, note: 'Macro-level hue/saturation control with a real Photoshop mask.' },
      ),
      adjustmentLayer(
        'Balance  (colour balance)',
        {
          type: 'colourBalance',
          shadows: labDeltaToRGBOffset(shift.shadow),
          midtones: labDeltaToRGBOffset(shift.mid),
          highlights: labDeltaToRGBOffset(shift.hi),
        },
        { mask: scaleMask(mask, 0.9), opacity: 45, note: 'Tonal balance derived from the correction; edit per range.' },
      ),
    ];

    if (s.faceNeckMatch > 1 || s.faceBodyMatch > 1) {
      children.push(
        adjustmentLayer(
          'Face ↔ body match  (selective colour)',
          { type: 'selectiveColour', cyan: 0, magenta: -Math.round(s.faceNeckMatch * 0.02), yellow: Math.round(s.faceBodyMatch * 0.02), black: 0 },
          { mask, opacity: 35, note: `Face-to-neck ${Math.round(s.faceNeckMatch)}% · face-to-body ${Math.round(s.faceBodyMatch)}%` },
        ),
      );
    }

    return [
      group(groupName, children, { opacity: s.opacity }),
    ];
  }
}

const tintChannel = (base, tint, weight) => base + (tint - base) * clamp(weight, 0, 1);

const resolveTreatment = (style, category, s) => {
  const base = style.treatment || {};
  const richness = category?.richness || {};
  // Category richness only contributes when the retoucher picked a style that
  // asks for it; neutral styles stay neutral.
  const wantsRichness = Object.keys(base).length > 0 && s.style !== 'neutral';
  return {
    luminance: (base.luminance || 0) + (wantsRichness ? (base.luminance || 0) * 0.1 : 0),
    warmth: (base.warmth || 0) + (wantsRichness ? (richness.warm || 0) * 20 : 0),
    saturation: (base.saturation || 0) + (wantsRichness ? (richness.saturation || 0) * 20 : 0),
    redPct: base.redPct || 0,
    yellowPct: base.yellowPct || 0,
    orangePct: base.orangePct || 0,
    hue: base.hue || 0,
    shadowLift: base.shadowLift || 0,
    midtoneLift: base.midtoneLift || 0,
    highlightWarmth: base.highlightWarmth || 0,
    highlightCool: base.highlightCool || 0,
    contrast: base.contrast || 0,
    uniformity: base.uniformity || 0,
    neutrality: base.neutrality || 0,
    highlightProtect: base.highlightProtect || 0,
  };
};

const referenceTarget = (s, treatment, category, measured, ctx) => {
  if (s.referenceMatch <= 0) return null;
  if (ctx.referenceLab) return ctx.referenceLab;
  // fall back to the palette anchor when no sample point was captured
  return category.lab;
};

const meanAbs = (values, mask) => {
  let sum = 0;
  let w = 0;
  for (let i = 0; i < values.length; i++) {
    const m = mask[i];
    if (m <= 0.01) continue;
    sum += Math.abs(values[i]) * m;
    w += m;
  }
  return w ? sum / w : 0;
};

const diffLayers = (before, after, mask) => {
  const zones = { shadow: { L: 0, a: 0, b: 0, n: 0 }, mid: { L: 0, a: 0, b: 0, n: 0 }, hi: { L: 0, a: 0, b: 0, n: 0 } };
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] <= 0.02) continue;
    const L0 = luma(before.r[i], before.g[i], before.b[i]);
    const lab0 = rgbToLab(before.r[i], before.g[i], before.b[i]);
    const lab1 = rgbToLab(after.r[i], after.g[i], after.b[i]);
    const t = L0 / 255;
    const z = t < 0.33 ? zones.shadow : t < 0.7 ? zones.mid : zones.hi;
    z.L += lab1.L - lab0.L;
    z.a += lab1.a - lab0.a;
    z.b += lab1.b - lab0.b;
    z.n++;
  }
  for (const k of Object.keys(zones)) {
    const z = zones[k];
    if (z.n) {
      z.L /= z.n;
      z.a /= z.n;
      z.b /= z.n;
    }
  }
  return zones;
};

const labDeltaToRGBOffset = (delta) => {
  if (!delta) return [0, 0, 0];
  return [
    clamp(Math.round(delta.a * 0.9 + delta.L * 0.25), -25, 25),
    clamp(Math.round(-delta.a * 0.45 - delta.b * 0.5 + delta.L * 0.25), -25, 25),
    clamp(Math.round(-delta.b * 0.9 + delta.L * 0.25), -25, 25),
  ];
};
