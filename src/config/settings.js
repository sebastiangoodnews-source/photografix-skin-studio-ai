import { defineSchema } from '../core/util/params.js';

export const VERSION = '1.0.0';

export const EDITION = { id: 'free-core', label: 'Free Core Edition' };

/** Default luminance / histogram analysis of a document. */
export const DEFAULT_ANALYSIS = {
  clippedHighlightsPct: 0,
  clippedShadowsPct: 0,
  skinCoveragePct: 0,
  medianLuma: 128,
  dynamicRange: 2,
};

/**
 * Global engine settings, shared by all modules. Individual modules receive their
 * own schema-validated parameter set and read these for cross-cutting behaviour.
 */
export const CORE_SCHEMA = defineSchema([
  {
    id: 'previewQuality',
    type: 'enum',
    label: 'Preview quality',
    group: 'Engine',
    options: [
      { value: 'fast', label: 'Fast (draft)' },
      { value: 'balanced', label: 'Balanced' },
      { value: 'accurate', label: 'Accurate' },
    ],
    default: 'balanced',
    help: 'Balanced previews analyse a downscaled frame, full output is always computed at document resolution.',
  },
  {
    id: 'previewMaxEdge',
    type: 'range',
    min: 320,
    max: 2400,
    step: 20,
    label: 'Preview max edge (px)',
    group: 'Engine',
    default: 1200,
  },
  {
    id: 'maskFeather',
    type: 'range',
    min: 0,
    max: 40,
    step: 0.5,
    unit: 'px',
    label: 'Auto mask feather',
    group: 'Masks',
    default: 6,
    help: 'Feather applied to every automatically generated region mask.',
  },
  {
    id: 'maskExpand',
    type: 'range',
    min: -20,
    max: 40,
    step: 1,
    unit: 'px',
    label: 'Auto mask expand',
    group: 'Masks',
    default: 2,
  },
  {
    id: 'protectIdentity',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Identity protection',
    group: 'Safeguards',
    default: 85,
    help: 'Limits how far any tool may move a pixel from the original. Never fully disabled.',
  },
  {
    id: 'highlightSafety',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Highlight clipping safety',
    group: 'Safeguards',
    default: 90,
  },
  {
    id: 'shadowSafety',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    label: 'Shadow crush safety',
    group: 'Safeguards',
    default: 80,
  },
  {
    id: 'layerPrefix',
    type: 'enum',
    label: 'Layer naming',
    group: 'Output',
    options: [
      { value: 'photografix', label: 'Photografix — Skin Studio' },
      { value: 'short', label: 'PX — Skin Studio' },
    ],
    default: 'photografix',
  },
]);

/**
 * Hard processing limits. These are the *guidelines* quoted in tool descriptions;
 * the panel never exposes them as magic numbers.
 */
export const LIMITS = {
  minRadius: 0.5,
  maxRadius: 60,
  minStrength: 0,
  maxStrength: 100,
  maxDocumentPixels: 64 * 1024 * 1024,
};
