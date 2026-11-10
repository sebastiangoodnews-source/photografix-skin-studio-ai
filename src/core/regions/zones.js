import { clamp } from '../util/math.js';
import { detectFace, faceLandmarks, ellipseMask } from '../segmentation/face.js';
import { detectBody, silhouetteContour } from '../segmentation/body.js';
import { skinMask } from '../analysis/skin.js';
import { unionMasks, intersectMasks, rectMask, refineMask, edgeAwareRefine } from '../masks/masks.js';
import { featherMask } from '../analysis/regions.js';

/**
 * Region resolver: one analysis pass, shared by every tool.
 *
 * Tools never re-detect the face. They ask the resolver for the mask of the region
 * the retoucher selected (face, neck, chest, arms, legs, full body, custom) and the
 * analysis results that go with it (landmarks, light direction, skin statistics,
 * body anchors). This is what keeps "face and body" consistent between
 * Frequency Separation, Micro/Sculpt D&B and Glossy Skin.
 */

export const REGION_IDS = ['face', 'neck', 'chest', 'arms', 'legs', 'fullBody', 'custom'];

export const REGION_LABELS = {
  face: 'Face',
  neck: 'Neck',
  chest: 'Chest',
  arms: 'Arms',
  legs: 'Legs',
  fullBody: 'Full body',
  custom: 'Custom selection',
};

export class RegionResolver {
  constructor(core = {}) {
    this.core = { maskFeather: 6, maskExpand: 2, ...core };
    this.cache = new Map();
  }

  /** Full analysis of a frame, memoised by frame identity. */
  analyse(frame, options = {}) {
    const key = options.cacheKey || frame;
    if (this.cache.has(key) && !options.force) return this.cache.get(key);
    const face = detectFace(frame, options.face || {});
    const landmarks = face.found ? faceLandmarks(frame, face) : null;
    const body = detectBody(frame, face, options.body || {});
    const skin = skinMask(frame, { low: 0.28, high: 0.64 });
    const contour = body.found ? silhouetteContour(body.skin || skin, frame.width, frame.height, 4) : [];
    // Head skin: the face mask minus the neck. Face tools (gloss, lips, sculpt)
    // must never treat the neck as a face, otherwise the chin line disappears.
    const headSkin = new Float32Array(frame.width * frame.height);
    const neckZone = body.zones?.neck;
    for (let i = 0; i < headSkin.length; i++) {
      const faceV = face.mask ? face.mask[i] : 0;
      headSkin[i] = neckZone ? Math.max(0, faceV - neckZone[i]) : faceV;
    }
    const analysis = { frame, face, landmarks, body, skin, headSkin, contour, regions: { face: headSkin } };
    if (this.cache.size > 6) this.cache.clear();
    this.cache.set(key, analysis);
    return analysis;
  }

  clear() {
    this.cache.clear();
  }

  /** Mask for one region id. */
  regionMask(analysis, regionId, options = {}) {
    const { width, height } = analysis.frame;
    // A custom selection depends on caller-supplied geometry, so it is never
    // cached; caching it would return a stale rectangle on the next call.
    const cacheable = regionId !== 'custom';
    if (cacheable && analysis.regions[regionId]) return analysis.regions[regionId];
    let mask = null;
    switch (regionId) {
      case 'face':
        mask = analysis.regions.face
          ? Float32Array.from(analysis.regions.face)
          : analysis.face.mask
            ? Float32Array.from(analysis.face.mask)
            : null;
        break;
      case 'neck':
        mask = analysis.body.zones?.neck || null;
        break;
      case 'chest':
        mask = analysis.body.zones?.chest
          ? unionMasks([analysis.body.zones.chest, analysis.body.zones.shoulders])
          : null;
        break;
      case 'arms':
        mask = analysis.body.zones?.arms || null;
        break;
      case 'legs':
        mask = analysis.body.zones?.legs ? unionMasks([analysis.body.zones.legs, analysis.body.zones.knees || new Float32Array(width * height)]) : null;
        break;
      case 'fullBody': {
        const parts = [analysis.skin];
        if (analysis.body.zones?.legs) parts.push(analysis.body.zones.legs);
        mask = unionMasks(parts);
        break;
      }
      case 'custom':
        mask = options.customMask
          ? Float32Array.from(options.customMask)
          : options.customRect
            ? rectMask(width, height, options.customRect, options.feather ?? this.core.maskFeather)
            : analysis.skin;
        break;
      default:
        mask = analysis.skin;
    }
    if (!mask) mask = new Float32Array(width * height);
    // Body regions derive from the skin likelihood field already; the face mask
    // comes from connected components, so it gets an edge-aware pass here.
    if (regionId === 'face' && options.refine !== false) {
      mask = edgeAwareRefine(mask, analysis.frame, 3, 0.002);
    }
    if (options.refine !== false) {
      mask = refineMask(mask, width, height, {
        feather: options.feather ?? this.core.maskFeather,
        expand: options.expand ?? this.core.maskExpand,
        smooth: 1,
        speckleRadius: 1,
      });
    }
    if (cacheable) analysis.regions[regionId] = mask;
    return mask;
  }

  /**
   * Composite mask for a region selection. `face`/`body` toggles let a tool target
   * both halves of the workflow at once (e.g. Micro D&B over face + chest).
   */
  selectionMask(analysis, selection = {}, options = {}) {
    const { region = 'face', face: wantFace = true, body: wantBody = false, customMask, customRect } = selection;
    const { width, height } = analysis.frame;
    const parts = [];
    if (region === 'custom') {
      parts.push(this.regionMask(analysis, 'custom', { customMask, customRect, refine: false }));
    } else if (region === 'fullBody') {
      parts.push(this.regionMask(analysis, 'fullBody', options));
    } else if (region === 'face') {
      if (wantFace) parts.push(this.regionMask(analysis, 'face', options));
    } else if (['neck', 'chest', 'arms', 'legs'].includes(region)) {
      parts.push(this.regionMask(analysis, region, options));
    }
    if (wantBody && region === 'face') {
      const bodyZones = analysis.body.zones || {};
      const bodyParts = Object.values(bodyZones).filter(Boolean);
      if (bodyParts.length) parts.push(unionMasks(bodyParts));
      else parts.push(this.regionMask(analysis, 'fullBody', options));
    }
    if (!parts.length) parts.push(new Float32Array(width * height).fill(1));
    let mask = parts.length === 1 ? parts[0] : unionMasks(parts);
    if (options.intersectSkin) {
      mask = intersectMasks([mask, analysis.skin]);
    }
    return mask;
  }

  /**
   * Skin-colour regions derived from the detected anatomy: face skin, neck/chest
   * skin, and everything else. Used for face-to-neck / face-to-body matching.
   */
  matchZones(analysis, options = {}) {
    const { width, height } = analysis.frame;
    const faceMask = this.regionMask(analysis, 'face', { refine: false });
    const neck = analysis.body.zones?.neck || new Float32Array(width * height);
    const chest = analysis.body.zones?.chest || new Float32Array(width * height);
    const bodyMask = unionMasks([neck, chest]);
    return {
      face: featherMask(faceMask, width, height, options.feather ?? 4),
      neckChest: featherMask(bodyMask, width, height, options.feather ?? 4),
    };
  }
}

export const describeRegion = (regionId) => REGION_LABELS[regionId] || 'Selection';

/** Human-readable status line for the panel header. */
export const summariseAnalysis = (analysis) => {
  const face = analysis.face;
  const body = analysis.body;
  return {
    faceDetected: Boolean(face?.found),
    faceMethod: face?.method || 'none',
    faceConfidence: clamp(face?.confidence || 0),
    bodyZones: body?.zonesPresent || [],
    bodyConfidence: clamp(body?.confidence || 0),
    skinCoverage: 0,
  };
};
