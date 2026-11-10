import { clamp, smoothstep } from '../util/math.js';
import { defineSchema } from '../util/params.js';
import { Frame } from '../image/frame.js';
import { blurFrame, blurChannelArray } from '../image/filters.js';
import { lumaArray, estimateLightDirection } from '../analysis/histogram.js';
import { faceRegionMasks } from '../segmentation/face.js';
import { featherMask } from '../analysis/regions.js';
import { intersectMasks, unionMasks, refineMask, createProtectionMask, detailProtectionMask } from '../masks/masks.js';
import { group, pixelLayer } from '../layers/record.js';
import { ProcessingEngine } from './common.js';
import { SCULPT_PRESET_VALUES } from '../../config/presets.js';
import { softLightOffset, softLightOffsetNegative } from '../image/blend.js';

/**
 * SculptDodgeBurnEngine
 *
 * Purpose: shape FORM and DIMENSION with light (not fix small inconsistencies -
 * that is the micro engine). The engine never moves geometry: it adds light and
 * shadow where the subject's own anatomy and the photograph's own key light say
 * a highlight or falloff would naturally fall.
 *
 * Method:
 *   1. estimate the key-light direction from the image (no invented lighting)
 *   2. ask the face/body segmenter for anatomical anchors and contours
 *   3. place feathered highlight blobs offset toward the light and shadow blobs
 *      offset away from it, along each anchor's normal
 *   4. gate by existing exposure so nothing blows out or crushes
 *
 * Output is two independent, paintable layers (highlight and shadow), each with a
 * real layer mask, exactly as a retoucher builds a sculpt dodge & burn pair.
 */

export const SCULPT_DB_SCHEMA = defineSchema([
  { id: 'preset', type: 'enum', label: 'Preset', group: 'Sculpt', options: [
    { value: 'subtle', label: 'Subtle (natural)' },
    { value: 'natural', label: 'Natural' },
    { value: 'dramatic', label: 'Dramatic' },
    { value: 'custom', label: 'Custom' },
  ], default: 'natural' },
  { id: 'target', type: 'enum', label: 'Target', group: 'Target', options: [
    { value: 'face', label: 'Face' },
    { value: 'body', label: 'Body' },
    { value: 'faceBody', label: 'Face + body' },
  ], default: 'faceBody' },
  { id: 'sculptStrength', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Sculpt strength', group: 'Sculpt', default: 18 },
  { id: 'highlightStrength', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Highlight strength', group: 'Sculpt', default: 22 },
  { id: 'shadowStrength', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Shadow strength', group: 'Sculpt', default: 14 },
  { id: 'highlightSoftness', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Highlight softness', group: 'Sculpt', default: 34 },
  { id: 'shadowSoftness', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Shadow softness', group: 'Sculpt', default: 40 },
  { id: 'feathering', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Feathering', group: 'Sculpt', default: 38 },
  { id: 'maskIntensity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Mask intensity', group: 'Sculpt', default: 60 },
  { id: 'brushSize', type: 'range', min: 10, max: 600, step: 1, unit: 'px', label: 'Brush size', group: 'Brush', default: 180 },
  { id: 'brushSoftness', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Brush softness', group: 'Brush', default: 75 },
  { id: 'followLight', type: 'bool', label: 'Follow existing light direction', group: 'Safeguards', default: true, help: 'Places highlights and shadows consistent with the light already in the photograph. Leave on unless the shot has flat, directionless lighting.' },
  { id: 'faceZones', type: 'enum', label: 'Face emphasis', group: 'Face', options: [
    { value: 'all', label: 'All facial contours' },
    { value: 'structure', label: 'Bone structure only' },
    { value: 'features', label: 'Features only (nose, brow, chin)' },
    { value: 'custom', label: 'Manual brush only' },
  ], default: 'all' },
  { id: 'bodyZones', type: 'enum', label: 'Body emphasis', group: 'Body', options: [
    { value: 'all', label: 'All body contours' },
    { value: 'upper', label: 'Shoulders, collarbone, chest' },
    { value: 'lower', label: 'Arms, waist, abdomen, legs' },
    { value: 'custom', label: 'Manual brush only' },
  ], default: 'upper' },
  { id: 'opacity', type: 'range', min: 0, max: 100, step: 1, unit: '%', label: 'Layer opacity', group: 'Output', default: 100 },
  { id: 'region', type: 'enum', label: 'Processing region', group: 'Target', options: [
    { value: 'face', label: 'Face' },
    { value: 'neck', label: 'Neck' },
    { value: 'chest', label: 'Chest' },
    { value: 'arms', label: 'Arms' },
    { value: 'legs', label: 'Legs' },
    { value: 'fullBody', label: 'Full body' },
    { value: 'custom', label: 'Custom selection' },
  ], default: 'fullBody' },
  { id: 'maskFeather', type: 'range', min: 0, max: 40, step: 0.5, unit: 'px', label: 'Mask feather', group: 'Masks', default: 10 },
]);

export class SculptDodgeBurnEngine extends ProcessingEngine {
  constructor() {
    super({ id: 'sculpt-dodge-burn', label: 'Sculpt Dodge & Burn', schema: SCULPT_DB_SCHEMA });
  }

  process(frame, s, ctx) {
    const analysis = ctx.analysis || ctx.resolver.analyse(frame);
    const { width, height, pixelCount } = frame;
    // Presets are parameter overlays on the same sliders, never a separate code
    // path: after a preset is applied the retoucher can move any slider and the
    // result stays predictable ("custom" simply means no overlay).
    const p = SCULPT_PRESET_VALUES[s.preset];
    const cfg = p ? { ...s, ...p } : s;
    const light = cfg.followLight ? estimateLightDirection(frame) : { x: -0.4, y: -0.55, confidence: 0.5, source: 'manual-neutral' };
    const skin = analysis.skin;

    const highlightMask = new Float32Array(pixelCount);
    const shadowMask = new Float32Array(pixelCount);
    let hiBlobSmooth = new Float32Array(pixelCount);
    let shBlobSmooth = new Float32Array(pixelCount);
    const debug = [];

    const featherPx = Math.max(2, cfg.feathering * 0.22 + 2);

    // ---------- FACE ----------
    if (analysis.face?.found && cfg.faceZones !== 'custom' && (cfg.target !== 'body')) {
      const zones = faceRegionMasks(frame, analysis.face, analysis.landmarks, { feather: featherPx });
      const faceSkin = zones.face;
      const e = analysis.face.ellipse;
      const scale = e.ry; // anatomical unit
      const hi = clamp(cfg.highlightSoftness / 100) * 0.9 + 0.1;
      const sh = clamp(cfg.shadowSoftness / 100) * 0.9 + 0.1;

      const addFaceBlob = (target, cx, cy, rx, ry, weight) => {
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
        stampEllipse(target, width, height, cx, cy, rx, ry, weight);
      };

      // Highlights ride toward the light; shadows fall away from it.
      // Highlights are pushed TOWARD the key light, shadows away from it, so the
      // added modelling reinforces the photograph's existing lighting.
      const lightOff = {
        x: light.x * scale * 0.16,
        y: light.y * scale * 0.16,
      };

      const structure = cfg.faceZones === 'all' || cfg.faceZones === 'structure';
      const features = cfg.faceZones === 'all' || cfg.faceZones === 'features';

      if (structure) {
        // cheekbones / temples / jawline / under-cheek
        const p = analysis.landmarks.points;
        addFaceBlob(highlightMask, p.leftCheekbone.x + lightOff.x, p.leftCheekbone.y + lightOff.y - scale * 0.02, e.rx * 0.26, e.ry * 0.1, 0.85 * hi);
        addFaceBlob(highlightMask, p.rightCheekbone.x + lightOff.x, p.rightCheekbone.y + lightOff.y - scale * 0.02, e.rx * 0.26, e.ry * 0.1, 0.85 * hi);
        addFaceBlob(shadowMask, p.leftUnderCheek.x - lightOff.x * 0.6, p.leftUnderCheek.y - lightOff.y * 0.6 + scale * 0.04, e.rx * 0.2, e.ry * 0.11, 0.8 * sh);
        addFaceBlob(shadowMask, p.rightUnderCheek.x - lightOff.x * 0.6, p.rightUnderCheek.y - lightOff.y * 0.6 + scale * 0.04, e.rx * 0.2, e.ry * 0.11, 0.8 * sh);
        addFaceBlob(shadowMask, p.leftTemple.x - lightOff.x * 0.5, p.leftTemple.y, e.rx * 0.11, e.ry * 0.12, 0.55 * sh);
        addFaceBlob(shadowMask, p.rightTemple.x - lightOff.x * 0.5, p.rightTemple.y, e.rx * 0.11, e.ry * 0.12, 0.55 * sh);
        // jawline definition: shadow just inside the jaw contour
        for (const side of [-1, 1]) {
          for (let k = 0; k <= 5; k++) {
            const t = 0.42 + k * 0.08;
            const ux = side * (1 - t * 0.28);
            const uy = t + 0.18;
            addFaceBlob(
              shadowMask,
              e.cx + ux * e.rx - lightOff.x * 0.35,
              e.cy + uy * e.ry,
              e.rx * 0.1,
              e.ry * 0.07,
              (0.5 - Math.abs(k - 2) * 0.06) * sh,
            );
          }
        }
      }

      if (features) {
        const p = analysis.landmarks.points;
        // forehead shaping
        addFaceBlob(highlightMask, p.forehead.x + lightOff.x * 0.5, p.forehead.y + scale * 0.06, e.rx * 0.45, e.ry * 0.16, 0.6 * hi);
        // nose bridge highlight + contour shadows on both sides
        addFaceBlob(highlightMask, p.noseBridgeMid.x + lightOff.x * 0.4, p.noseBridgeMid.y, e.rx * 0.055, e.ry * 0.2, 0.95 * hi);
        addFaceBlob(shadowMask, p.noseBridgeMid.x - e.rx * 0.09, p.noseBridgeMid.y + scale * 0.02, e.rx * 0.035, e.ry * 0.17, 0.45 * sh);
        addFaceBlob(shadowMask, p.noseBridgeMid.x + e.rx * 0.09, p.noseBridgeMid.y + scale * 0.02, e.rx * 0.035, e.ry * 0.17, 0.45 * sh);
        // brow bone
        addFaceBlob(highlightMask, p.leftBrowBone.x + lightOff.x * 0.3, p.leftBrowBone.y, e.rx * 0.15, e.ry * 0.05, 0.6 * hi);
        addFaceBlob(highlightMask, p.rightBrowBone.x + lightOff.x * 0.3, p.rightBrowBone.y, e.rx * 0.15, e.ry * 0.05, 0.6 * hi);
        // chin light
        addFaceBlob(highlightMask, p.chin.x + lightOff.x * 0.4, p.chin.y - scale * 0.01, e.rx * 0.2, e.ry * 0.09, 0.55 * hi);
        // under-chin falloff
        addFaceBlob(shadowMask, p.chin.x, p.chin.y + e.ry * 0.12, e.rx * 0.26, e.ry * 0.07, 0.4 * sh);
        debug.push('forehead', 'nose-bridge', 'nose-contour', 'brow-bone', 'chin');
      }

      // clip sculpt masks to facial skin only
      for (let i = 0; i < pixelCount; i++) {
        highlightMask[i] *= faceSkin[i];
        shadowMask[i] *= faceSkin[i];
      }
      debug.push('cheekbones', 'under-cheek', 'temples', 'jawline');
    }

    // ---------- BODY ----------
    //
    // Body form is not stamped from a list of blobs: it is read out of the
    // photograph's own lighting. A large-radius luminance envelope describes the
    // body's form; pixels brighter than the envelope are surfaces facing the key
    // light (they receive highlight), pixels darker are surfaces turning away (they
    // receive shadow). Anatomical ridges (collarbone, shoulder line) then get a small
    // extra push because that is where a retoucher would reinforce structure.
    if (analysis.body?.found && cfg.bodyZones !== 'custom' && cfg.target !== 'face') {
      const bz = analysis.body.zones;
      const anchors = analysis.body.anchors;
      const unit = anchors.faceHeight;
      const upper = cfg.bodyZones === 'all' || cfg.bodyZones === 'upper';
      const lower = cfg.bodyZones === 'all' || cfg.bodyZones === 'lower';
      const bodySkin = analysis.body.skin;
      const hiSoft = clamp(cfg.highlightSoftness / 100);
      const shSoft = clamp(cfg.shadowSoftness / 100);

      const chosen = [
        upper ? bz.shoulders : null,
        upper ? bz.chest : null,
        upper ? bz.collarbone : null,
        lower ? bz.arms : null,
        lower ? bz.waist : null,
        lower ? bz.abdomen : null,
        lower ? bz.legs : null,
      ].filter(Boolean);
      if (chosen.length) {
        const scope = unionMasks(chosen);
        const bodyLuma = lumaArray(frame);
        // Envelope radius spans the body's own form scale (not a local patch), so
        // the response describes shape rather than shading noise.
        const envelope = blurChannelArray(bodyLuma, width, height, Math.max(10, unit * 0.9));
        const smoothLuma = blurChannelArray(bodyLuma, width, height, Math.max(3, unit * 0.08));
        const hiBlob = new Float32Array(pixelCount);
        const shBlob = new Float32Array(pixelCount);
        for (let i = 0; i < pixelCount; i++) {
          const m = scope[i];
          if (m <= 0.02) continue;
          const env = Math.max(6, envelope[i]);
          const ratio = smoothLuma[i] / env;
          const lit = smoothstep(1.01, 1.16, ratio);
          const unlit = smoothstep(0.95, 0.84, ratio);
          // softness sliders widen the shoulder of the response
          hiBlob[i] = clamp(m * lit * (0.5 + hiSoft * 0.7));
          // shadows are held back: falloff is easy to overdo on body skin
          shBlob[i] = clamp(m * unlit * (0.4 + shSoft * 0.55));
        }

        // Anatomical ridge reinforcement (small, footprint-aware, light-relative).
        if (upper && bz.collarbone) {
          const cb = AnalysisSample(bz.collarbone, width, height);
          const ridgeR = Math.max(2, Math.round(unit * 0.055));
          for (const sample of cb.samples) {
            stampDiscLocal(hiBlob, width, height, sample.x, sample.y, ridgeR, 0.85);
            stampDiscLocal(shBlob, width, height, sample.x, sample.y + Math.round(unit * 0.05), ridgeR, 0.5);
          }
          debug.push('collarbone');
        }
        if (upper && bz.shoulders) {
          // shoulder line: highlight on the light-facing slope only
          const contour = analysis.contour || [];
          const step = Math.max(2, Math.round(unit * 0.04));
          for (let k = 0; k < contour.length; k += step) {
            const row = contour[k];
            if (row.y < anchors.shoulderY - unit * 0.1 || row.y > anchors.shoulderY + unit * 0.22) continue;
            const x = light.x <= 0 ? row.left + unit * 0.05 : row.right - unit * 0.05;
            stampDiscLocal(hiBlob, width, height, x, row.y, Math.max(2, Math.round(unit * 0.05)), 0.6);
          }
          debug.push('shoulders');
        }
        if (upper && bz.chest) debug.push('chest');
        if (lower) debug.push('arms', 'waist', 'abdomen', 'legs');

        // feather the form field
        const blurR = Math.max(2, cfg.feathering * 0.1);
        hiBlobSmooth = featherMask(hiBlob, width, height, blurR);
        shBlobSmooth = featherMask(shBlob, width, height, blurR);
        for (let i = 0; i < pixelCount; i++) {
          highlightMask[i] = Math.max(highlightMask[i], hiBlobSmooth[i] * (bodySkin ? bodySkin[i] : 1));
          shadowMask[i] = Math.max(shadowMask[i], shBlobSmooth[i] * (bodySkin ? bodySkin[i] : 1));
        }
      }
    }

    // region selection restricts everything (face / neck / chest / custom)
    const selection = ctx.resolver.selectionMask(analysis, { region: cfg.region }, {
      feather: cfg.maskFeather,
      customMask: ctx.customMask,
      customRect: ctx.customRect,
    });
    let hiMask = intersectMasks([highlightMask, selection, skin]);
    let shMask = intersectMasks([shadowMask, selection, skin]);
    const featherRadius = Math.max(1, cfg.feathering * 0.18);
    hiMask = featherMask(hiMask, width, height, featherRadius);
    shMask = featherMask(shMask, width, height, featherRadius);
    const lightConfidence = clamp(light.confidence);

    // Exposure gate: highlights only where there is headroom, shadows only where
    // there is something to darken. This is what prevents chalky highlights.
    const protection = createProtectionMask(frame, {
      highlightSafety: ctx.core?.highlightSafety ? ctx.core.highlightSafety / 100 : 0.9,
      shadowSafety: ctx.core?.shadowSafety ? ctx.core.shadowSafety / 100 : 0.8,
    });
    const lum = lumaArray(frame);
    const maskScale = cfg.maskIntensity / 100;
    for (let i = 0; i < pixelCount; i++) {
      const L = lum[i] / 255;
      const hiRoom = smoothstep(0.98, 0.62, L); // less highlight as we approach white
      const shRoom = smoothstep(0.02, 0.35, L); // less shadow as we approach black
      hiMask[i] = clamp(hiMask[i] * hiRoom * protection[i]);
      shMask[i] = clamp(shMask[i] * shRoom * protection[i]);
    }
    normaliseMask(hiMask, (cfg.maskIntensity / 100) * (0.45 + lightConfidence * 0.55));
    normaliseMask(shMask, (cfg.maskIntensity / 100) * (0.45 + lightConfidence * 0.55));

    // Build the paint layers: soft-light neutral-grey relief, per-channel gain.
    // Levels of added light, calibrated through inverse Soft Light so the panel
    // preview and the committed Photoshop layer stack agree exactly.
    //   subtle  preset: sculpt 18% x 26 levels ~= 2 levels  (barely-there modelling)
    //   dramatic preset: sculpt 56% x 26 levels ~= 15 levels (strong sculpt)
    const sculpt = cfg.sculptStrength / 100;
    const hiLevels = sculpt * (cfg.highlightStrength / 50) * 26;
    const shLevels = sculpt * (cfg.shadowStrength / 50) * 26;
    const lumField = lumaArray(frame);
    const highlightFrame = neutralFrame(width, height);
    const shadowFrame = neutralFrame(width, height);
    for (let i = 0; i < pixelCount; i++) {
      const src = clamp(lumField[i], 0, 254);
      const h = hiMask[i];
      const d = shMask[i];
      if (h > 0.002) {
        const v = softLightOffset(src, h * hiLevels);
        for (let c = 0; c < 3; c++) highlightFrame.channels[c][i] = v;
      }
      if (d > 0.002) {
        const v = softLightOffsetNegative(src, d * shLevels);
        for (let c = 0; c < 3; c++) shadowFrame.channels[c][i] = v;
      }
    }

    const layers = [
      group(
        ctx.layerName || 'Photografix — Skin Studio · Sculpt Dodge & Burn',
        [
          pixelLayer('Sculpt — Highlights  (Soft Light)', highlightFrame, {
            blendMode: 'softLight',
            opacity: cfg.opacity,
            mask: hiMask,
            note: 'Form-defining light. Paint or erase on the mask to reshape highlights. Reduce opacity for a subtler sculpt.',
          }),
          pixelLayer('Sculpt — Shadows  (Soft Light)', shadowFrame, {
            blendMode: 'softLight',
            opacity: cfg.opacity,
            mask: shMask,
            note: 'Contour and falloff. Independent from the highlight layer so each can be tuned separately.',
          }),
        ],
        { opacity: 100 },
      ),
    ];

    const preview = ctx.renderStack ? ctx.renderStack(layers, frame) : frame.clone();

    return {
      layers,
      preview,
      mask: unionMasks([hiMask, shMask]),
      masks: { highlights: hiMask, shadows: shMask },
      light,
      analysis: {
        target: cfg.target,
        preset: s.preset,
        lightDirection: light,
        regions: Array.from(new Set(debug)),
        highlightCoverage: coverageOf(hiMask),
        shadowCoverage: coverageOf(shMask),
        faceDetected: Boolean(analysis.face?.found),
        bodyDetected: Boolean(analysis.body?.found),
      },
      report: {
        preset: s.preset,
        resolved: { sculptStrength: cfg.sculptStrength, highlightStrength: cfg.highlightStrength, shadowStrength: cfg.shadowStrength },
        levels: { highlights: hiLevels, shadows: shLevels },
        lightSource: light.source,
        lightConfidence: light.confidence,
        regions: Array.from(new Set(debug)),
        layers: ['highlights', 'shadows'],
      },
    };
  }
}

/** Peak-normalise a coverage mask (shape preserved, strength on the mask). */
/** Stamp a soft disc into a mask, keeping the maximum. */
const stampDiscLocal = (mask, width, height, cx, cy, radius, weight) => {
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / radius;
      if (d > 1) continue;
      const v = weight * (1 - d) * (1 - d);
      const i = y * width + x;
      if (v > mask[i]) mask[i] = v;
    }
  }
};

const normaliseMask = (mask, target = 1) => {
  let peak = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > peak) peak = mask[i];
  if (peak <= 1e-6) return mask;
  const k = target / peak;
  for (let i = 0; i < mask.length; i++) mask[i] *= k;
  return mask;
};

// Blob scale: anatomical sculpting reads as soft gradients, not spots. 1.7x on the
// geometrical ellipse sizes gives coverage a retoucher would brush by hand.
const BLOB_SCALE = 1.7;

const stampEllipse = (target, width, height, cx, cy, rxIn, ryIn, weight) => {
  const rx = rxIn * BLOB_SCALE;
  const ry = ryIn * BLOB_SCALE;
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(height - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      const falloff = 1 - d;
      const v = weight * falloff * falloff;
      const i = y * width + x;
      if (v > target[i]) target[i] = v;
    }
  }
};

const neutralFrame = (width, height) => {
  const f = new Frame(width, height);
  for (let c = 0; c < 3; c++) f.channels[c].fill(128);
  return f;
};

const AnalysisSample = (mask, width, height) => {
  const samples = [];
  const step = Math.max(4, Math.round(width / 60));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (mask[y * width + x] > 0.6) samples.push({ x, y });
    }
  }
  return { samples };
};

const coverageOf = (m) => {
  let s = 0;
  for (let i = 0; i < m.length; i++) s += m[i];
  return m.length ? s / m.length : 0;
};
