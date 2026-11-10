import { FrequencySeparationEngine } from './frequencySeparation.js';
import { AdvancedFrequencyEngine } from './advancedFrequency.js';
import { ProfessionalFrequencyEngine } from './professionalFrequency.js';
import { MicroDodgeBurnEngine } from './microDodgeBurn.js';
import { SculptDodgeBurnEngine } from './sculptDodgeBurn.js';
import { SkinToneEngine } from './skinTone.js';
import { ColourGradingEngine } from './colourGrading.js';
import { GlossySkinEngine } from './glossySkin.js';
import { FinalReviewEngine } from './finalReview.js';

/**
 * Single registry of processing engines. The panel builds itself from this list,
 * the orchestrator resolves tools by id, and the test suite iterates it - so a new
 * engine cannot be added in one place and forgotten in another.
 */

export const ENGINE_REGISTRY = [
  { id: 'frequency-separation-normal', stage: 1, tool: 'frequency', modes: ['normal'], factory: () => new FrequencySeparationEngine(), description: 'Conventional, fully brushable frequency separation.' },
  { id: 'frequency-separation-advanced', stage: 1, tool: 'frequency', modes: ['advanced'], factory: () => new AdvancedFrequencyEngine(), description: 'Guided separation with skin-aware smoothing.' },
  { id: 'frequency-separation-professional', stage: 1, tool: 'frequency', modes: ['professional'], factory: () => new ProfessionalFrequencyEngine(), description: 'Multi-scale beauty separation.' },
  { id: 'micro-dodge-burn', stage: 2, tool: 'microDodgeBurn', factory: () => new MicroDodgeBurnEngine(), description: 'Small tonal corrections on face and body.' },
  { id: 'sculpt-dodge-burn', stage: 3, tool: 'sculptDodgeBurn', factory: () => new SculptDodgeBurnEngine(), description: 'Form and dimension sculpting with light.' },
  { id: 'skin-tone', stage: 4, tool: 'skinTone', factory: () => new SkinToneEngine(), description: 'African and melanin-rich skin tone science.' },
  { id: 'colour-grading', stage: 5, tool: 'colourGrading', factory: () => new ColourGradingEngine(), description: 'Cinematic, wedding and signature grades.' },
  { id: 'glossy-skin', stage: 6, tool: 'glossySkin', factory: () => new GlossySkinEngine(), description: 'Intelligent gloss, highlights, lips and contour.' },
  { id: 'final-review', stage: 7, tool: 'review', factory: () => new FinalReviewEngine(), description: 'QA, safety checks and the last finishing controls.' },
];

export class EngineRegistry {
  constructor(entries = ENGINE_REGISTRY) {
    this.entries = entries;
    this.instances = new Map();
  }

  list() {
    return this.entries.map(({ factory, ...meta }) => meta);
  }

  byTool(tool) {
    return this.entries.filter((e) => e.tool === tool);
  }

  has(id) {
    return this.entries.some((e) => e.id === id);
  }

  create(id) {
    if (this.instances.has(id)) return this.instances.get(id);
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`Unknown engine: ${id}`);
    const engine = entry.factory();
    this.instances.set(id, engine);
    return engine;
  }

  /** Resolve the engine for a tool id plus its mode (the three FS modes). */
  forTool(tool, mode) {
    const candidates = this.byTool(tool);
    if (!candidates.length) throw new Error(`No engine registered for tool "${tool}"`);
    if (mode) {
      const match = candidates.find((c) => c.modes?.includes(mode));
      if (match) return this.create(match.id);
    }
    return this.create(candidates[0].id);
  }

  schemasFor(tool) {
    return this.byTool(tool).map((e) => ({ id: e.id, modes: e.modes || null, schema: this.create(e.id).schema }));
  }
}

export const defaultRegistry = new EngineRegistry();
