import { clamp, smoothstep, luma } from '../util/math.js';
import { defineSchema } from '../util/params.js';
import { Frame } from '../image/frame.js';
import { blurFrame, blurChannelArray } from '../image/filters.js';
import { lumaArray } from '../analysis/histogram.js';
import { rgbToLab, labToRgb } from '../image/colorspace.js';
import { skinMask } from '../analysis/skin.js';
import {
  unionMasks,
  intersectMasks,
  scaleMask,
  refineMask,
  tonalMask,
  detailProtectionMask,
  createProtectionMask,
} from '../masks/masks.js';
import { featherMask } from '../analysis/regions.js';
import { group, pixelLayer, adjustmentLayer } from '../layers/record.js';
import { softLightOffset, softLightOffsetNegative } from '../image/blend.js';

/** Scale a coverage mask so its peak is `target` (peak-normalised, shape kept). */
const normaliseMask = (mask, target = 1) => {
  let peak = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > peak) peak = mask[i];
  if (peak <= 1e-6) return mask;
  const k = target / peak;
  for (let i = 0; i < mask.length; i++) mask[i] *= k;
  return mask;
};
import { ProcessingEngine } from './common.js';
import { detectHighlights, HIGHLIGHT_AREAS, skinMedianLuma } from './highlightDetection.js';
import { detectLips, buildLipHighlights } from './lipEnhancement.js';
import { GLOSS_PRESET_VALUES } from '../../config/presets.js';

/**
 * GlossySkinEngine
 *
 * Stage 6, the finishing tool. Glossy skin is a LIGHT problem, not a blur problem,
 * so this engine does four things and nothing else:
 *
 *   1. Glow     - a soft, luminance-weighted lift of the skin, built from a blurred
 *                 skin-only luminance map combined with the original via Soft Light,
 *                 so texture is never replaced.
 *   2. Highlights - placed only where the HighlightDetectionEngine says a natural
 *                 highlight belongs (anatomy + the photograph's own light).
 *   3. Lips     - independent, texture-preserving lip gloss and contour.
 *   4. Contour  - subtle bone/contour light that follows the existing key light.
 *
 * Every part lands on its own layer with a real mask and independent opacity, and
 * the whole group defaults to a subtle professional level.
 */

export const GLOSSY_SCHEMA = defineSchema([
  {
    id: 'preset', type: 'enum', label: 'Gloss preset', group: 'Gloss', options: [
      { value: 'subtle-glow', label: 'Subtle Glow' },
      { value: 'natural-gloss', label: 'Natural Gloss' },
      { value: 'beauty-gloss', label: 'Beauty Gloss' },
      { value: 'premium-gloss', label: 'Premium Gloss' },
      { value: 'custom', label: 'Custom' },
    ], default: 'subtle-glow',
  },
  { id: 'target', type: 'enum', label: 'Target', group: 'Target', options: [
    { value: 'face', label: 'Face' },
    { value: 'body', label: 'Body' },
    { value: 'faceBody', label: 'Face + body' },
  ], default: 'faceBody' },
  { id: 'glowIntensity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Glow intensity', group: 'Glow', default: 14 },
  { id: 'highlightIntensity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Highlight intensity', group: 'Highlights', default: 18 },
  { id: 'highlightSpread', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Highlight spread', group: 'Highlights', default: 34 },
  { id: 'highlightSoftness', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Highlight softness', group: 'Highlights', default: 40 },
  { id: 'highlightOpacity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Highlight opacity', group: 'Highlights', default: 55 },
  { id: 'highlightColour', type: 'colour', label: 'Highlight colour', group: 'Highlights', default: [255, 250, 242] },
  { id: 'warmth', type: 'range', min: -30, max: 30, step: 1, label: 'Warmth', group: 'Glow', default: 0 },
  { id: 'skinReflection', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Skin reflection', group: 'Glow', default: 30, help: 'How much of the glow comes from reflected light in the skin rather than added light. Higher keeps melasma-free, realistic sheen on deep skin.' },
  { id: 'glossSmoothness', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Gloss smoothness', group: 'Glow', default: 45 },
  { id: 'maskStrength', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Mask strength', group: 'Masks', default: 70 },
  { id: 'lipEnhance', type: 'bool', label: 'Lip enhancement', group: 'Lips', default: true },
  { id: 'lipGloss', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Lip gloss intensity', group: 'Lips', default: 28 },
  { id: 'lipHighlights', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Lip highlights', group: 'Lips', default: 24 },
  { id: 'lipContour', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Lip contour', group: 'Lips', default: 18 },
  { id: 'lipBrightness', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Lip brightness', group: 'Lips', default: 10 },
  { id: 'lipPreserveColour', type: 'bool', label: 'Preserve lip colour', group: 'Lips', default: true, help: 'Never recolours lips: hue and chroma are held, only light changes.' },
  { id: 'contourEnhance', type: 'bool', label: 'Bone & contour enhancement', group: 'Contour', default: true },
  { id: 'contourIntensity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Contour intensity', group: 'Contour', default: 16 },
  { id: 'followLight', type: 'bool', label: 'Follow existing light direction', group: 'Safeguards', default: true },
  { id: 'textureProtect', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Skin texture protection', group: 'Safeguards', default: 80, help: 'Keeps pore detail out of the glow. This is the main control that prevents plastic skin.' },
  { id: 'region', type: 'enum', label: 'Processing region', group: 'Target', options: [
    { value: 'face', label: 'Face' },
    { value: 'neck', label: 'Neck' },
    { value: 'chest', label: 'Chest' },
    { value: 'arms', label: 'Arms' },
    { value: 'legs', label: 'Legs' },
    { value: 'fullBody', label: 'Full body' },
    { value: 'custom', label: 'Custom selection' },
  ], default: 'fullBody' },
  { id: 'opacity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Group opacity', group: 'Output', default: 100 },
  { id: 'maskFeather', type: 'range', min: 0, max: 40, step: 0.5, unit: 'px', label: 'Mask feather', group: 'Output', default: 10 },
]);

export class GlossySkinEngine extends ProcessingEngine {
  constructor() {
    super({ id: 'glossy-skin', label: 'Photografix Glossy Skin', schema: GLOSSY_SCHEMA });
  }

  process(frame, s, ctx) {
    const analysis = ctx.analysis || ctx.resolver.analyse(frame);
    const { width, height, pixelCount } = frame;
    const preset = resolveGlossPreset(s);
    const target = s.target;
    const includeFace = target !== 'body';
    const includeBody = target !== 'face';

    const selection = ctx.resolver.selectionMask(analysis, { region: s.region }, {
      feather: s.maskFeather,
      customMask: ctx.customMask,
      customRect: ctx.customRect,
    });
    const skin = analysis.skin || skinMask(frame, {});
    let skinScope = intersectMasks([selection, skin]);
    if (includeFace && !includeBody && analysis.face?.found) {
      skinScope = intersectMasks([skinScope, analysis.regions.face || new Float32Array(pixelCount).fill(1)]);
    }
    skinScope = refineMask(skinScope, width, height, { feather: s.maskFeather, expand: 0, smooth: 1, speckleRadius: 1 });

    // ---------------- Highlight detection ----------------
    const detection = detectHighlights(frame, analysis, {
      includeFace,
      includeBody,
      spread: s.highlightSpread / 100,
      faceStrength: preset.highlightIntensity / 60,
      bodyStrength: (preset.highlightIntensity / 60) * 0.9,
    });

    const luma = lumaArray(frame);
    const protection = createProtectionMask(frame, {
      highlightSafety: ctx.core?.highlightSafety ? ctx.core.highlightSafety / 100 : 0.9,
      shadowSafety: ctx.core?.shadowSafety ? ctx.core.shadowSafety / 100 : 0.8,
    });
    const features = detailProtectionMask(frame, { threshold: 0.13, softness: 0.06, radius: 2 });
    const textureGuard = s.textureProtect / 100;

    // ---------------- 1. Skin glow ----------------
    const glowMask = new Float32Array(pixelCount);
    const smoothness = preset.glossSmoothness / 100;
    // Glow placement uses LOCAL contrast, not an absolute or global exposure test:
    // a pixel glows when its skin is brighter than the surrounding skin. That is
    // melanin-neutral (deep and fair skin behave identically) and it follows the
    // photograph's own light instead of inventing a key light.
    const minEdge = Math.min(width, height);
    const localLuma = blurChannelArray(luma, width, height, Math.max(3, minEdge * 0.035));
    const envelopeLuma = blurChannelArray(luma, width, height, Math.max(6, minEdge * 0.16));
    for (let i = 0; i < pixelCount; i++) {
      const m = skinScope[i];
      if (m <= 0.001) continue;
      const L = luma[i] / 255;
      const lit = localLuma[i] / Math.max(4, envelopeLuma[i]);
      // glow lives on the lit part of the skin, never on the speculars
      const tonalWindow = smoothstep(0.96, 1.14, lit) * (1 - smoothstep(0.88, 0.995, L));
      // features is a PROTECTION mask (1 on skin); only true edges are excluded
      const textureOk = 1 - (1 - features[i]) * textureGuard;
      // coverage only: the preset's strength is applied as levels of light later,
      // so the layer mask always describes WHERE the glow goes
      glowMask[i] = clamp(m * tonalWindow * textureOk);
    }
    normaliseMask(glowMask, s.maskStrength / 100);
    const glowFrame = buildGlowLayer(frame, glowMask, {
      blurRadius: Math.max(4, Math.min(width, height) * (0.012 + smoothness * 0.02)),
      reflection: preset.skinReflection / 100,
      warmth: preset.warmth,
      textureGuard,
      levels: preset.glowIntensity * 0.3,
    });

    // ---------------- 2. Facial highlights ----------------
    const faceHighlightMask = new Float32Array(pixelCount);
    for (const area of Object.values(detection.areas)) {
      if (!HIGHLIGHT_AREAS.face.some((a) => a.id === area.id)) continue;
      for (let i = 0; i < pixelCount; i++) faceHighlightMask[i] = clamp(faceHighlightMask[i] + area.zone[i]);
    }
    const faceHighlights = buildHighlightLayer(frame, faceHighlightMask, {
      levels: preset.highlightIntensity * 0.24,
      colour: preset.highlightColour,
      protection,
      textureGuard,
      features,
    });

    // ---------------- 3. Body highlights ----------------
    const bodyHighlightMask = new Float32Array(pixelCount);
    for (const area of Object.values(detection.areas)) {
      if (HIGHLIGHT_AREAS.face.some((a) => a.id === area.id)) continue;
      for (let i = 0; i < pixelCount; i++) bodyHighlightMask[i] = clamp(bodyHighlightMask[i] + area.zone[i]);
    }
    const bodyHighlights = buildHighlightLayer(frame, bodyHighlightMask, {
      levels: preset.highlightIntensity * 0.21,
      colour: preset.highlightColour,
      protection,
      textureGuard,
      features,
    });

    // ---------------- 4. Lips ----------------
    let lipFrame = null;
    let lipMask = null;
    let lipMeta = null;
    if (s.lipEnhance && analysis.face?.found) {
      const lip = detectLips(frame, analysis);
      if (lip) {
        const lipBuild = buildLipHighlights(frame, lip, {
          strength: s.lipHighlights / 100,
          gloss: preset.lipGloss ?? s.lipGloss / 100,
          contour: s.lipContour / 100,
          brightness: s.lipBrightness / 100,
          texture: s.lipPreserveColour ? 0.7 : 0.3,
        });
        lipFrame = buildLipLayer(frame, lipBuild, {
          colour: preset.highlightColour,
          preserveColour: s.lipPreserveColour,
          brightness: s.lipBrightness / 100,
          glossIntensity: (preset.lipGloss ?? s.lipGloss / 100),
        });
        lipMask = lip.mask;
        lipMeta = { detected: true, coverage: coverageOf(lip.mask) };
      }
    }

    // ---------------- 5. Contour ----------------
    let contourFrame = null;
    let contourMask = null;
    if (s.contourEnhance) {
      const contourAreas = ['cheekbones', 'browBones', 'chin', 'collarbone', 'noseBridge', 'noseTip', 'shoulders', 'contour'].filter((id) => detection.areas[id]);
      if (contourAreas.length) {
        contourMask = new Float32Array(pixelCount);
        for (const id of contourAreas) {
          const z = detection.areas[id].zone;
          for (let i = 0; i < pixelCount; i++) contourMask[i] = clamp(contourMask[i] + z[i] * 0.7);
        }
        let peak = 0;
        for (let i = 0; i < pixelCount; i++) if (contourMask[i] > peak) peak = contourMask[i];
        const norm = peak > 0.001 ? 1 / peak : 0;
        for (let i = 0; i < pixelCount; i++) contourMask[i] = clamp(contourMask[i] * norm * (s.maskStrength / 100));
        contourFrame = buildHighlightLayer(frame, contourMask, {
          levels: s.contourIntensity * 0.2,
          colour: preset.highlightColour,
          protection,
          textureGuard,
          features,
        });
      }
    }

    // ---------------- Layer stack ----------------
    const children = [
      pixelLayer('Skin glow  (Soft Light)', glowFrame, {
        blendMode: 'softLight',
        opacity: 100,
        mask: glowMask,
        note: 'Soft-light glow from a skin-only luminance map. Reduce opacity or paint the mask to tune.',
      }),
      pixelLayer('Facial highlights  (Soft Light)', faceHighlights.frame, {
        blendMode: 'softLight',
        opacity: preset.highlightOpacity,
        mask: faceHighlights.mask,
        note: 'Only the facial zones the detector approved for this light direction.',
      }),
      includeBody && bodyHighlights.hasContent
        ? pixelLayer('Body highlights  (Soft Light)', bodyHighlights.frame, {
            blendMode: 'softLight',
            opacity: preset.highlightOpacity * 0.9,
            mask: bodyHighlights.mask,
            note: 'Collarbone, shoulders, chest, arm and leg highlights, gated by the existing light.',
          })
        : null,
      s.lipEnhance && lipFrame
        ? pixelLayer('Lip enhancement  (Soft Light)', lipFrame, {
            blendMode: 'softLight',
            opacity: 90,
            mask: lipMask,
            note: 'Gloss, highlight and contour. Lip colour is preserved; striation texture kept.',
          })
        : null,
      s.contourEnhance && contourFrame
        ? pixelLayer('Contour enhancement  (Soft Light)', contourFrame.frame, {
            blendMode: 'softLight',
            opacity: 30,
            mask: contourFrame.mask,
            note: 'Bone and contour light consistent with the photograph key light.',
          })
        : null,
      adjustmentLayer('Gloss polish  (curves)', { type: 'curves', luma: [[0, 0], [64, 65], [128, 130], [200, 201], [255, 254]] }, {
        mask: scaleMask(skinScope, 0.8),
        opacity: 45,
        note: 'Holds the glow together tonally. Edit or reduce for a more matte finish.',
      }),
    ].filter(Boolean);

    const layers = [group('Photografix — Skin Studio · Glossy Skin Studio', children, { opacity: s.opacity })];
    const preview = ctx.renderStack ? ctx.renderStack(layers, frame) : frame.clone();

    return {
      layers,
      preview,
      mask: unionMasks([glowMask, faceHighlights.mask, bodyHighlights.mask].filter(Boolean)),
      detection,
      analysis: {
        preset: s.preset,
        target,
        lightDirection: detection.light,
        highlightsFound: Object.keys(detection.areas),
        highlightsSkipped: detection.skipped,
        glowCoverage: coverageOf(glowMask),
        faceHighlightCoverage: coverageOf(faceHighlights.mask),
        bodyHighlightCoverage: bodyHighlights.hasContent ? coverageOf(bodyHighlights.mask) : 0,
        lipDetected: Boolean(lipMeta?.detected),
        contourApplied: Boolean(contourFrame),
        presetValues: preset,
      },
      report: {
        preset: s.preset,
        layers: children.length,
        areas: Object.keys(detection.areas),
        skipped: detection.skipped.map((s2) => `${s2.id}: ${s2.reason}`),
        light: detection.light.source,
      },
    };
  }
}

const resolveGlossPreset = (s) => {
  const base = GLOSS_PRESET_VALUES[s.preset];
  if (!base) {
    return {
      glowIntensity: s.glowIntensity,
      highlightIntensity: s.highlightIntensity,
      highlightSpread: s.highlightSpread,
      highlightSoftness: s.highlightSoftness,
      highlightOpacity: s.highlightOpacity,
      glossSmoothness: s.glossSmoothness,
      skinReflection: s.skinReflection,
      warmth: s.warmth,
      highlightColour: s.highlightColour,
      lipGloss: s.lipGloss / 100,
    };
  }
  return {
    ...base,
    skinReflection: s.skinReflection,
    warmth: base.warmth !== undefined ? base.warmth + s.warmth : s.warmth,
    highlightColour: s.highlightColour,
    lipGloss: s.lipGloss / 100,
  };
};

/**
 * Glow layer for Soft Light.
 *
 * Intent is expressed in LEVELS OF ADDED LIGHT (a few levels is already visible on
 * skin, a dozen is a glossy beauty look), then converted into the layer value that
 * produces exactly that much light through Photoshop's Soft Light maths. This is
 * why the glow can be increased without the face turning into a white disc.
 */
const buildGlowLayer = (frame, mask, options) => {
  const { width, height, pixelCount } = frame;
  const { blurRadius, reflection, warmth, textureGuard, levels } = options;
  const luma = lumaArray(frame);
  const soft = blurChannelArray(luma, width, height, blurRadius);
  const detail = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) detail[i] = luma[i] - soft[i];
  const out = new Frame(width, height);
  // Reflection: the share of the glow that comes from the skin's own reflected
  // colour (structure-preserving) vs. added light (lifting).
  for (let i = 0; i < pixelCount; i++) {
    const m = mask[i];
    if (m <= 0.001) {
      out.r[i] = 128;
      out.g[i] = 128;
      out.b[i] = 128;
      continue;
    }
    // The layer carries the FULL calibrated light; the layer mask (coverage)
    // decides how much of it lands. This is exactly how a retoucher works: paint
    // the glow, mask it down.
    const reflectionTerm = (soft[i] - luma[i]) * reflection * 0.22;
    const addedLevels = levels + reflectionTerm;
    const source = clamp(luma[i], 0, 254);
    const base = addedLevels >= 0 ? softLightOffset(source, addedLevels) : softLightOffsetNegative(source, -addedLevels);
    const detailKeep = detail[i] * (1 - textureGuard) * 0.35;
    out.r[i] = clamp(base + detailKeep + warmth * 0.25, 0, 255);
    out.g[i] = clamp(base + detailKeep, 0, 255);
    out.b[i] = clamp(base + detailKeep - warmth * 0.3, 0, 255);
  }
  return out;
};

/**
 * Highlight layer for Soft Light. Each area mask is already anatomy- and
 * light-gated; here it becomes a calibrated amount of extra light, never a
 * clipped specular.
 */
const buildHighlightLayer = (frame, mask, options) => {
  const { width, height, pixelCount } = frame;
  const { levels, colour, protection, textureGuard, features } = options;
  const luma = lumaArray(frame);
  const out = new Frame(width, height);
  const finalMask = new Float32Array(pixelCount);
  let hasContent = false;
  const chromatic = [
    (colour[0] - 250) * 0.5,
    (colour[1] - 250) * 0.5,
    (colour[2] - 250) * 0.5,
  ];
  for (let i = 0; i < pixelCount; i++) {
    const m = mask[i];
    const headroom = 1 - smoothstep(0.82, 0.995, luma[i] / 255);
    const textureOk = 1 - (1 - features[i]) * textureGuard;
    const w = clamp(m * protection[i] * headroom * textureOk);
    finalMask[i] = w;
    if (w > 0.02) hasContent = true;
    if (w <= 0.001) {
      out.r[i] = 128;
      out.g[i] = 128;
      out.b[i] = 128;
      continue;
    }
    const added = levels;
    const source = clamp(luma[i], 0, 254);
    out.r[i] = clamp(softLightOffset(source, added) + chromatic[0] * w, 0, 255);
    out.g[i] = clamp(softLightOffset(source, added) + chromatic[1] * w, 0, 255);
    out.b[i] = clamp(softLightOffset(source, added) + chromatic[2] * w, 0, 255);
  }
  return { frame: out, mask: finalMask, hasContent };
};

/**
 * Lips: luminance-only enhancement. Hue and chroma are preserved by keeping the
 * layer neutral, so the lip's own colour shows through the Soft Light.
 */
const buildLipLayer = (frame, lipBuild, options) => {
  const { width, height, pixelCount } = frame;
  const { colour, preserveColour, brightness, glossIntensity } = options;
  const luma = lumaArray(frame);
  const out = new Frame(width, height);
  const chromatic = [(colour[0] - 250) * 0.35, (colour[1] - 250) * 0.35, (colour[2] - 250) * 0.35];
  for (let i = 0; i < pixelCount; i++) {
    const gloss = lipBuild.gloss[i];
    const contour = lipBuild.contour[i];
    if (gloss <= 0.001 && contour <= 0.001) {
      out.r[i] = 128;
      out.g[i] = 128;
      out.b[i] = 128;
      continue;
    }
    const lipLevels = gloss * 22 * glossIntensity + brightness * 8 - contour * 12;
    const source = clamp(luma[i], 0, 254);
    const base = lipLevels >= 0 ? softLightOffset(source, lipLevels) : softLightOffsetNegative(source, -lipLevels);
    if (preserveColour) {
      out.r[i] = clamp(base, 0, 255);
      out.g[i] = clamp(base, 0, 255);
      out.b[i] = clamp(base, 0, 255);
    } else {
      out.r[i] = clamp(base + chromatic[0] * gloss, 0, 255);
      out.g[i] = clamp(base + chromatic[1] * gloss, 0, 255);
      out.b[i] = clamp(base + chromatic[2] * gloss, 0, 255);
    }
  }
  return out;
};

const coverageOf = (m) => {
  let s = 0;
  for (let i = 0; i < m.length; i++) s += m[i];
  return m.length ? s / m.length : 0;
};
