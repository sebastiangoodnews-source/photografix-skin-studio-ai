import { clamp, smoothstep } from '../util/math.js';
import { defineSchema } from '../util/params.js';
import { Frame } from '../image/frame.js';
import { blurFrame, blurChannelArray } from '../image/filters.js';
import { lumaArray } from '../analysis/histogram.js';
import { analyseFaceSurface, faceRegionMasks } from '../segmentation/face.js';
import { summariseSkin } from '../analysis/skin.js';
import { intersectMasks, refineMask, scaleMask, detailProtectionMask, edgeAwareRefine, unionMasks } from '../masks/masks.js';
import { featherMask } from '../analysis/regions.js';
import { group, pixelLayer, adjustmentLayer } from '../layers/record.js';
import { ProcessingEngine, splitFrequencies, textureGate, detectBlemishes, medianApprox } from './common.js';
import { rgbToLab, labToRgb } from '../image/colorspace.js';

/**
 * ProfessionalFrequencyEngine - MODE 3: Professional (multi-scale).
 *
 * Three frequency bands, each with its own legitimate purpose:
 *
 *   band 0  form/lighting      (radius R3)  - tonal transitions, never blurred away
 *   band 1  structure          (radius R2)  - patchiness, texture clumps
 *   band 2  pore detail        (radius R1)  - the detail we must NOT destroy
 *
 * Facial sub-regions are treated differently because the retouching problem is
 * different in each: forehead accepts more smoothing, under-eye needs colour work
 * but almost no texture work, nose needs pore retention, chin/jaw needs transition
 * control. All of that is data from the face segmenter, not a hard-coded ellipse.
 *
 * Texture reconstruction: rather than subtracting detail and hoping it looks
 * natural, the engine measures the local pore amplitude in the original and
 * re-synthesises an equivalent amplitude from the surviving detail, so the result
 * keeps skin-like micro-relief at any smoothing level.
 */

export const PROFESSIONAL_FS_SCHEMA = defineSchema([
  { id: 'intensity', type: 'enum', label: 'Intensity', group: 'Quality', options: [
    { value: 'very-subtle', label: 'Very subtle' },
    { value: 'subtle', label: 'Subtle (recommended)' },
    { value: 'natural', label: 'Natural' },
    { value: 'medium', label: 'Medium' },
    { value: 'strong', label: 'Strong' },
    { value: 'custom', label: 'Custom' },
  ], default: 'subtle', help: 'Quality-first default. Increase only after reviewing at 100%.' },
  { id: 'baseRadius', type: 'range', min: 2, max: 40, step: 0.5, unit: 'px', label: 'Base radius (pore scale)', group: 'Bands', default: 6 },
  { id: 'structureRadius', type: 'range', min: 4, max: 60, step: 0.5, unit: 'px', label: 'Structure radius', group: 'Bands', default: 14 },
  { id: 'formRadius', type: 'range', min: 8, max: 90, step: 0.5, unit: 'px', label: 'Form radius', group: 'Bands', default: 32 },
  { id: 'adaptiveBands', type: 'bool', label: 'Adaptive band scaling', group: 'Bands', default: true, help: 'Scales band radii from face size and resolution so the split means the same thing on a 24MP and a 60MP file.' },
  { id: 'structureSmoothing', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Structure smoothing', group: 'Texture', default: 34 },
  { id: 'poreDetail', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Pore detail retained', group: 'Texture', default: 82 },
  { id: 'textureReconstruction', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Texture reconstruction', group: 'Texture', default: 45 },
  { id: 'blemishIsolation', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Blemish isolation', group: 'Texture', default: 50 },
  { id: 'colourTransition', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Colour transition correction', group: 'Colour', default: 38 },
  { id: 'complexionEvenness', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Uneven complexion correction', group: 'Colour', default: 30 },
  { id: 'regionalTreatment', type: 'bool', label: 'Per-region facial treatment', group: 'Anatomy', default: true, help: 'Forehead, cheek, nose, under-eye, chin and jaw each get their own balance of texture and colour work.' },
  { id: 'region', type: 'enum', label: 'Processing region', group: 'Region', options: [
    { value: 'face', label: 'Face' },
    { value: 'neck', label: 'Neck' },
    { value: 'chest', label: 'Chest' },
    { value: 'arms', label: 'Arms' },
    { value: 'legs', label: 'Legs' },
    { value: 'fullBody', label: 'Full body' },
    { value: 'custom', label: 'Custom selection' },
  ], default: 'face' },
  { id: 'maskFeather', type: 'range', min: 0, max: 24, step: 0.5, unit: 'px', label: 'Mask feather', group: 'Region', default: 6 },
  { id: 'strength', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Overall strength', group: 'Output', default: 50 },
  { id: 'opacity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Group opacity', group: 'Output', default: 100 },
]);

/** Per-region balance of structure smoothing vs colour work (0..1 multipliers). */
export const REGIONAL_BALANCE = {
  forehead: { texture: 1.18, colour: 1.0, pore: 0.92, transition: 1.0 },
  cheeks: { texture: 1.0, colour: 1.15, pore: 1.05, transition: 1.1 },
  nose: { texture: 0.55, colour: 0.85, pore: 1.3, transition: 0.8 },
  underEye: { texture: 0.35, colour: 1.35, pore: 0.7, transition: 1.25 },
  chin: { texture: 0.9, colour: 1.05, pore: 1.0, transition: 1.0 },
  jawline: { texture: 0.75, colour: 0.9, pore: 1.0, transition: 0.9 },
  cheekbones: { texture: 0.85, colour: 1.0, pore: 1.15, transition: 1.0 },
  temples: { texture: 1.05, colour: 1.05, pore: 0.95, transition: 1.0 },
  default: { texture: 1, colour: 1, pore: 1, transition: 1 },
};

export class ProfessionalFrequencyEngine extends ProcessingEngine {
  constructor() {
    super({ id: 'frequency-separation-professional', label: 'Frequency Separation — Professional', schema: PROFESSIONAL_FS_SCHEMA });
  }

  process(frame, s, ctx) {
    const analysis = ctx.analysis || ctx.resolver.analyse(frame);
    const { width, height, pixelCount } = frame;

    const regionMaskBase = ctx.resolver.selectionMask(analysis, { region: s.region }, {
      feather: s.maskFeather,
      customMask: ctx.customMask,
      customRect: ctx.customRect,
    });

    const surface = analysis.face?.found ? analyseFaceSurface(frame, analysis.face) : null;
    const intensityScale = resolveIntensity(s);

    // Adaptive band radii: derived from face size + resolution, so a band always
    // addresses the same anatomical scale regardless of camera.
    let base = s.baseRadius;
    let structure = s.structureRadius;
    let form = s.formRadius;
    if (s.adaptiveBands && analysis.face?.ellipse) {
      const e = analysis.face.ellipse;
      // Reference: a 230 px tall face (a 320x420 test frame) uses the declared
      // radii unchanged. Anything larger scales up proportionally, so "base"
      // genuinely means pore scale on a 24 MP file instead of a fixed pixel count.
      const faceH = e.ry * 2;
      const scale = clamp(faceH / 230, 0.45, 3.2);
      base = clamp(base * scale, 2, 40);
      structure = clamp(structure * scale, 4, 60);
      form = clamp(form * scale, 8, 90);
      if (surface) base = clamp(base * (0.85 + surface.textureNorm * 0.4), 2, 40);
    }

    // ---- Band 1: form (kept, only gently blended) ----
    const formLow = blurFrame(frame, form);
    const structureLow = blurFrame(frame, structure);

    // ---- Band 2: structure ----
    const structureBand = new Frame(width, height);
    const poreBand = new Frame(width, height);
    const poreLow = blurFrame(frame, base);
    for (let c = 0; c < 3; c++) {
      const f = frame.channels[c];
      const fl = formLow.channels[c];
      const sl = structureLow.channels[c];
      const pl = poreLow.channels[c];
      const sb = structureBand.channels[c];
      const pb = poreBand.channels[c];
      for (let i = 0; i < pixelCount; i++) {
        sb[i] = clamp(sl[i] - fl[i] + 128, 0, 255);
        pb[i] = clamp(f[i] - pl[i] + 128, 0, 255);
      }
    }

    // ---- Gates ----
    const gate = textureGate(frame, {
      radius: Math.max(1.5, base * 0.5),
      threshold: 4.5 + (s.poreDetail / 100) * 6,
      softness: 3.2,
    });
    const features = detailProtectionMask(frame, { threshold: 0.1, softness: 0.045, radius: 2 });
    const blemishes = s.blemishIsolation > 0
      ? detectBlemishes(frame, { sensitivity: s.blemishIsolation / 100, maxRadius: Math.max(3, base) })
      : null;

    // Per-pixel regional balance
    const texBalance = new Float32Array(pixelCount).fill(1);
    const colBalance = new Float32Array(pixelCount).fill(1);
    const poreBalance = new Float32Array(pixelCount).fill(1);
    const regionsUsed = ['default'];
    if (s.regionalTreatment && analysis.face?.found && (s.region === 'face' || s.region === 'fullBody')) {
      const zones = faceRegionMasks(frame, analysis.face, analysis.landmarks, { feather: Math.max(2, Math.round(base * 0.5)) });
      regionsUsed.length = 0;
      for (const [name, zone] of Object.entries(zones)) {
        const bal = REGIONAL_BALANCE[name] || REGIONAL_BALANCE.default;
        if (!bal) continue;
        let touched = false;
        for (let i = 0; i < pixelCount; i++) {
          const w = zone[i];
          if (w <= 0.01) continue;
          touched = true;
          texBalance[i] = texBalance[i] * (1 - w) + bal.texture * w;
          colBalance[i] = colBalance[i] * (1 - w) + bal.colour * w;
          poreBalance[i] = poreBalance[i] * (1 - w) + bal.pore * w;
        }
        if (touched) regionsUsed.push(name);
      }
    }

    // ---- Compose smoothed structure band ----
    const smoothing = (s.structureSmoothing / 100) * intensityScale;
    const poreKeep = s.poreDetail / 100;
    const reconstruct = s.textureReconstruction / 100;
    const structureOut = structureBand.clone();
    for (let c = 0; c < 3; c++) {
      const sb = structureBand.channels[c];
      const pb = poreBand.channels[c];
      const so = structureOut.channels[c];
      for (let i = 0; i < pixelCount; i++) {
        const detail = sb[i] - 128;
        let keep = 1 - smoothing * gate[i] * features[i] * texBalance[i];
        if (blemishes) keep *= 1 - blemishes[i] * 0.7;
        // reconstruction: re-inject a fraction of surviving pore-scale amplitude so
        // the surface keeps micro-relief instead of going waxy
        const poreSignal = (pb[i] - 128) * (poreKeep * poreBalance[i] * reconstruct * 0.35);
        so[i] = clamp(128 + detail * keep + poreSignal * gate[i], 0, 255);
      }
    }

    // ---- Colour transitions in Lab ----
    // The form layer starts from the ORIGINAL photograph, never from the blurred
    // low pass: a blurred layer at 100% would erase eyes, lips and lashes. Only the
    // colour-transition corrections below are written into it, so fine structure
    // comes from the structure layer and form keeps every feature.
    const formOut = frame.clone();
    const transitionAmt = (s.colourTransition / 100) * intensityScale;
    const evenAmt = (s.complexionEvenness / 100) * intensityScale;
    if (transitionAmt > 0.001 || evenAmt > 0.001) {
      const A = new Float32Array(pixelCount);
      const B = new Float32Array(pixelCount);
      const L = new Float32Array(pixelCount);
      // chroma analysis runs on the low pass (that is the colour signal), but the
      // corrected result is written onto the original pixels
      const f = formLow;
      for (let i = 0; i < pixelCount; i++) {
        const lab = rgbToLab(f.r[i], f.g[i], f.b[i]);
        A[i] = lab.a;
        B[i] = lab.b;
        L[i] = lab.L;
      }
      const localscale = Math.max(4, structure * 2.2);
      const Am = blurChannelArray(A, width, height, localscale);
      const Bm = blurChannelArray(B, width, height, localscale);
      const Lm = blurChannelArray(L, width, height, localscale * 1.6);
      const Lmed = medianApprox(L, width, height, Math.max(3, Math.round(structure)));

      for (let i = 0; i < pixelCount; i++) {
        // The low pass supplies the local colour REFERENCE (Am/Bm/Lmed); the
        // original supplies the pixels we write. Detail therefore survives: only
        // chroma drift is pulled toward the local mean, never luminance detail.
        const devA = A[i] - Am[i];
        const devB = B[i] - Bm[i];
        const devMag = Math.hypot(devA, devB);
        const outlier = smoothstep(4, 14, devMag);
        const colW = transitionAmt * colBalance[i] * outlier;
        const orig = rgbToLab(frame.r[i], frame.g[i], frame.b[i]);
        const a = orig.a - devA * colW;
        const b = orig.b - devB * colW;
        // complexion evenness: remove slow luminance drift only (small, bounded)
        const drift = clamp((Lmed[i] - L[i]) * evenAmt * 0.45 + (Lm[i] - L[i]) * evenAmt * 0.25, -8, 8);
        const rgb = labToRgb(clamp(orig.L + drift, 0, 100), a, b);
        formOut.r[i] = clamp(rgb.r, 0, 255);
        formOut.g[i] = clamp(rgb.g, 0, 255);
        formOut.b[i] = clamp(rgb.b, 0, 255);
      }
    }

    // ---- Masks ----
    let mask = intersectMasks([regionMaskBase, analysis.skin]);
    mask = edgeAwareRefine(mask, frame, 3, 0.002);
    mask = refineMask(mask, width, height, { feather: s.maskFeather, expand: 0, smooth: 1, speckleRadius: 1 });

    const layers = [
      group(
        ctx.layerName || 'Photografix — Skin Studio · Frequency Separation (Professional)',
        [
          pixelLayer('Form  (light modelling, preserved)', formOut, {
            safeguard: true,
            blendMode: 'normal',
            opacity: 100,
            mask,
            note: 'Large-scale modelling only. Colour transitions corrected here; structure and light shape kept.',
          }),
          pixelLayer('Structure  (texture reconstruction)', structureOut, {
            safeguard: false,
            blendMode: 'linearLight',
            opacity: 100,
            mask: scaleMask(mask, 0.9),
            note: 'Structure band with reconstructed pore amplitude. Lowest-impact layer to reduce if skin reads soft.',
          }),
          pixelLayer('Treatment map  (regional balance)', balanceVisualisation(texBalance, colBalance, poreBalance, width, height), {
            blendMode: 'normal',
            opacity: 0,
            mask: null,
            note: 'Diagnostic map (starts hidden): red = texture treatment, blue = colour treatment. Useful for reviewing which regions were touched.',
          }),
          adjustmentLayer(
            'Complexion  (editable curves)',
            { type: 'curves', luma: [[0, 0], [80, 81], [150, 150], [210, 211], [255, 255]] },
            { mask, opacity: 55 },
          ),
        ],
        { opacity: s.opacity },
      ),
    ];

    const preview = ctx.renderStack ? ctx.renderStack(layers, frame) : frame.clone();
    const skinStats = summariseSkin(formOut, mask);
    return {
      mode: 'professional',
      layers,
      preview,
      mask,
      radiusUsed: { base, structure, form },
      analysis: {
        faceConfidence: analysis.face?.confidence ?? 0,
        bands: { base, structure, form },
        regionsTreated: regionsUsed,
        melanin: skinStats?.melanin ?? 0,
        undertone: skinStats?.undertone ?? 'unknown',
        intensity: s.intensity,
      },
      report: {
        mode: 'professional',
        intensity: s.intensity,
        intensityScale,
        radii: { base, structure, form },
        adaptive: Boolean(s.adaptiveBands && analysis.face?.ellipse),
        regionsTreated: regionsUsed,
        coverage: coverageOf(mask),
      },
    };
  }
}

const resolveIntensity = (s) => {
  const map = { 'very-subtle': 0.32, subtle: 0.5, natural: 0.68, medium: 0.85, strong: 1 };
  const base = s.strength / 100;
  if (s.intensity === 'custom') return base;
  return clamp(base * (map[s.intensity] ?? 0.5) + (map[s.intensity] ?? 0.5) * 0.4, 0, 1.4);
};

const balanceVisualisation = (tex, col, pore, width, height) => {
  const f = new Frame(width, height);
  for (let i = 0; i < f.pixelCount; i++) {
    const t = clamp(tex[i] - 1, -0.5, 0.5);
    const c = clamp(col[i] - 1, -0.5, 0.5);
    f.r[i] = clamp(128 + t * 180, 0, 255);
    f.g[i] = clamp(128 + (pore[i] - 1) * 120, 0, 255);
    f.b[i] = clamp(128 + c * 180, 0, 255);
  }
  return f;
};

const coverageOf = (mask) => {
  let s = 0;
  for (let i = 0; i < mask.length; i++) s += mask[i];
  return mask.length ? s / mask.length : 0;
};
