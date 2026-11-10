import { Frame } from '../image/frame.js';
import { RegionResolver } from '../regions/zones.js';
import { renderStack } from '../layers/render.js';
import { validateLayerTree, countLayers, group } from '../layers/record.js';
import { defaultRegistry } from '../engines/registry.js';
import { createLogger } from '../util/log.js';
import { clamp } from '../util/math.js';
import { validateAgainst } from '../engines/common.js';
import { STAGE_ORDER } from '../../config/presets.js';

const log = createLogger('orchestrator');

/**
 * WorkflowOrchestrator
 *
 * Owns the retouching session: the document frame, the ordered stack of applied
 * stages, the shared analysis, and the preview/commit lifecycle.
 *
 * Design guarantees:
 *  - STAGES ARE INDEPENDENT. Each stage renders from the composite of the stages
 *    below it, so any stage can be disabled, reordered or re-run without losing
 *    the work of the others (non-destructive by construction).
 *  - A STAGE'S SOURCE IS THE ORIGINAL PLUS LOWER STAGES. Turning a stage off sends
 *    its output back to its own source, never to black.
 *  - NOTHING IS FLATTENED. Every run appends layer records; the Photoshop bridge
 *    replays them as groups inside the live document.
 *  - Using one tool alone works: if the retoucher only opens Glossy Skin, the
 *    composite is the original plus that stage.
 */

export class WorkflowSession {
  constructor({ registry = defaultRegistry, core = {}, resolver = null } = {}) {
    this.registry = registry;
    this.core = { previewQuality: 'balanced', previewMaxEdge: 1200, protectIdentity: 85, highlightSafety: 90, shadowSafety: 80, maskFeather: 6, maskExpand: 2, layerPrefix: 'photografix', ...core };
    this.resolver = resolver || new RegionResolver(this.core);
    this.original = null;
    this.stages = [];
    this.nextOrder = 1;
    this.cache = { composite: null, layers: null };
  }

  setDocument(frame, meta = {}) {
    if (!(frame instanceof Frame)) throw new TypeError('setDocument expects a Frame');
    this.original = frame;
    this.meta = meta;
    this.stages = [];
    this.nextOrder = 1;
    this.resolver.clear();
    this.invalidate();
    this.analysis = this.resolver.analyse(frame);
    return this.analysis;
  }

  invalidate() {
    this.cache.composite = null;
    this.cache.layers = null;
  }

  hasDocument() {
    return Boolean(this.original);
  }

  /** Composite of every enabled stage, in stage order. */
  composite() {
    if (this.cache.composite) return this.cache.composite;
    if (!this.original) throw new Error('No document loaded');
    let out = this.original;
    for (const stage of this.orderedStages()) {
      if (!stage.enabled) continue;
      out = stage.output;
    }
    this.cache.composite = out;
    return out;
  }

  orderedStages() {
    return [...this.stages].sort((a, b) => a.order - b.order);
  }

  /** All layer records, grouped per stage (top of stack first = newest stage). */
  layerStack() {
    if (this.cache.layers) return this.cache.layers;
    const records = [];
    for (const stage of [...this.orderedStages()].reverse()) {
      if (!stage.enabled) continue;
      const doc = group(`${stage.label}`, stage.layers, {
        visible: true,
        opacity: stage.groupOpacity ?? 100,
        note: `Stage ${stage.stage}: ${stage.label}`,
      });
      records.push(doc);
    }
    this.cache.layers = records;
    return records;
  }

  /**
   * Run one stage. `input` defaults to the composite of the enabled stages below.
   * Returns the session stage entry; the caller (panel) does not touch frames.
   */
  runStage({ tool, engineId = null, mode = null, settings = {}, label = null, stage = null, customMask = null, customRect = null, referenceLab = null, name = null, groupOpacity = null }) {
    if (!this.original) throw new Error('Load a document before running a stage');
    const engine = engineId ? this.registry.create(engineId) : this.registry.forTool(tool, mode);
    const analysis = this.analysis || this.resolver.analyse(this.original);
    const input = this.composite();
    const validated = validateAgainst(engine.schema, settings);

    const context = {
      analysis,
      resolver: this.resolver,
      core: this.core,
      renderStack,
      customMask,
      customRect,
      referenceLab,
      layerName: name || null,
      // Stage 7 compares the live composite against the untouched original, so the
      // original frame travels with the context. Engines that do not need it ignore it.
      original: this.original,
    };

    const t0 = Date.now();
    const result = engine.run(input, validated, context);
    const ms = Date.now() - t0;

    const stageEntry = {
      id: `stage-${this.nextOrder}`,
      order: this.nextOrder++,
      stage: stage ?? engineStage(engine.id),
      tool,
      engineId: engine.id,
      label: label || stageLabel(stage ?? engineStage(engine.id), engine.label),
      settings: result.report?.settings || validated,
      layers: result.layers || [],
      output: result.preview || input,
      analysis: result.analysis || {},
      report: result.report || {},
      enabled: true,
      groupOpacity: groupOpacity ?? 100,
      elapsedMs: ms,
      createdAt: new Date().toISOString(),
    };

    const validation = validateLayerTree(stageEntry.layers);
    if (!validation.ok) {
      log.warn('layer tree validation failed', validation.errors);
      stageEntry.layerWarnings = validation.errors;
    }
    this.stages.push(stageEntry);
    this.invalidate();
    log.info(`stage ${stageEntry.id} ran`, { engine: engine.id, ms, layers: countLayers(stageEntry.layers) });
    return stageEntry;
  }

  /**
   * Re-run an existing stage with new settings (the "adjust after the operation"
   * requirement). The stage keeps its position in the stack.
   */
  updateStage(stageId, settings) {
    const stage = this.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Unknown stage ${stageId}`);
    const index = this.stages.indexOf(stage);
    const below = this.orderedStages().filter((s) => s.order < stage.order && s.enabled);
    let input = this.original;
    for (const s of below) input = s.output;

    const engine = this.registry.create(stage.engineId);
    const analysis = this.analysis || this.resolver.analyse(this.original);
    const merged = { ...stage.settings, ...settings };
    const validated = validateAgainst(engine.schema, merged);
    const result = engine.run(input, validated, {
      analysis,
      resolver: this.resolver,
      core: this.core,
      renderStack,
      original: this.original,
    });
    const updated = {
      ...stage,
      settings: result.report?.settings || validated,
      layers: result.layers,
      output: result.preview || input,
      analysis: result.analysis || {},
      report: result.report || {},
      elapsedMs: Date.now(),
    };
    this.stages[index] = updated;
    // Stages above must be recomputed because their input changed.
    const above = this.orderedStages().filter((s) => s.order > updated.order);
    let out = updated.output;
    for (const s of above) {
      const eng = this.registry.create(s.engineId);
      const res = eng.run(out, s.settings, { analysis, resolver: this.resolver, core: this.core, renderStack, original: this.original });
      s.layers = res.layers;
      s.output = res.preview || out;
      s.report = res.report || {};
      out = s.output;
    }
    this.invalidate();
    return updated;
  }

  setStageEnabled(stageId, enabled) {
    const stage = this.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Unknown stage ${stageId}`);
    stage.enabled = Boolean(enabled);
    this.recomputeFrom(stage.order);
    return stage;
  }

  setStageOpacity(stageId, opacity) {
    const stage = this.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Unknown stage ${stageId}`);
    stage.groupOpacity = clamp(opacity, 0, 100);
    const group = stage.layers[0];
    if (group && group.type === 'group') group.opacity = stage.groupOpacity;
    this.recomputeStageOutputs();
    return stage;
  }

  removeStage(stageId) {
    const index = this.stages.findIndex((s) => s.id === stageId);
    if (index < 0) throw new Error(`Unknown stage ${stageId}`);
    const [removed] = this.stages.splice(index, 1);
    this.recomputeStageOutputs();
    return removed;
  }

  /** Move a stage in the workflow order (stage 3 before stage 2, etc.). */
  moveStage(stageId, newOrder) {
    const stage = this.stages.find((s) => s.id === stageId);
    if (!stage) throw new Error(`Unknown stage ${stageId}`);
    const target = clamp(Math.round(newOrder), 1, this.stages.length);
    for (const s of this.stages) {
      if (s.id === stageId) continue;
      if (stage.order < target && s.order > stage.order && s.order <= target) s.order -= 1;
      else if (stage.order > target && s.order >= target && s.order < stage.order) s.order += 1;
    }
    stage.order = target;
    this.recomputeStageOutputs();
    return stage;
  }

  recomputeFrom(order) {
    const analysedStages = this.orderedStages().filter((s) => s.order >= order);
    this.recomputeStageOutputs(analysedStages);
  }

  recomputeStageOutputs(only = null) {
    const targets = only || this.orderedStages();
    let input = this.original;
    for (const stage of this.orderedStages()) {
      const engine = this.registry.create(stage.engineId);
      const context = { analysis: this.analysis, resolver: this.resolver, core: this.core, renderStack, original: this.original };
      const result = engine.run(input, stage.settings, context);
      stage.layers = result.layers;
      stage.output = result.preview || input;
      stage.report = result.report || {};
      if (stage.enabled) input = stage.output;
    }
    this.invalidate();
    return this;
  }

  /** Before/after frames at the requested preview scale. */
  compare() {
    return { before: this.original, after: this.composite() };
  }

  previewPair(maxEdge = this.core.previewMaxEdge) {
    const before = this.original;
    const after = this.composite();
    const scale = Math.min(1, maxEdge / Math.max(before.width, before.height));
    if (scale >= 0.999) return { before, after, scale: 1 };
    const w = Math.max(1, Math.round(before.width * scale));
    const h = Math.max(1, Math.round(before.height * scale));
    return { before: before.resize(w, h), after: after.resize(w, h), scale };
  }

  /** Most recent stage for a given engine id (used to preload UI settings). */
  latestStageForTool(engineId) {
    for (let i = this.stages.length - 1; i >= 0; i--) {
      if (this.stages[i].engineId === engineId) return this.stages[i];
    }
    return null;
  }

  summary() {
    return {
      hasDocument: Boolean(this.original),
      document: this.original ? { width: this.original.width, height: this.original.height } : null,
      stages: this.orderedStages().map((s) => ({
        id: s.id,
        order: s.order,
        stage: s.stage,
        tool: s.tool,
        engineId: s.engineId,
        label: s.label,
        enabled: s.enabled,
        opacity: s.groupOpacity,
        layers: countLayers(s.layers),
        settings: Object.keys(s.settings).length,
      })),
      layerCount: this.layerStack().reduce((acc, g) => acc + countLayers([g]), 0),
      analysis: this.analysis
        ? {
            faceDetected: Boolean(this.analysis.face?.found),
            faceConfidence: this.analysis.face?.confidence ?? 0,
            bodyZones: this.analysis.body?.zonesPresent || [],
          }
        : null,
    };
  }

  /** Serialisable snapshot of the session (settings only, no frame data). */
  serialize() {
    return {
      version: 1,
      document: this.meta || null,
      core: this.core,
      stages: this.orderedStages().map((s) => ({
        id: s.id,
        order: s.order,
        stage: s.stage,
        tool: s.tool,
        engineId: s.engineId,
        label: s.label,
        enabled: s.enabled,
        groupOpacity: s.groupOpacity,
        settings: s.settings,
      })),
    };
  }

  /** Re-run a saved session against a (possibly different) document. */
  restore(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.stages)) throw new Error('Invalid session snapshot');
    this.core = { ...this.core, ...(snapshot.core || {}) };
    const pending = [...snapshot.stages].sort((a, b) => a.order - b.order);
    this.stages = [];
    this.nextOrder = 1;
    for (const st of pending) {
      const engine = this.registry.create(st.engineId);
      const entry = this.runStage({
        tool: st.tool,
        engineId: st.engineId,
        settings: st.settings,
        label: st.label,
        stage: st.stage,
        groupOpacity: st.groupOpacity,
      });
      entry.enabled = st.enabled !== false;
      if (engine && st.label) entry.label = st.label;
    }
    this.recomputeStageOutputs();
    return this;
  }
}

const engineStage = (engineId) => {
  const found = {
    'frequency-separation-normal': 1,
    'frequency-separation-advanced': 1,
    'frequency-separation-professional': 1,
    'micro-dodge-burn': 2,
    'sculpt-dodge-burn': 3,
    'skin-tone': 4,
    'colour-grading': 5,
    'glossy-skin': 6,
    'final-review': 7,
  }[engineId];
  return found || 1;
};

const stageLabel = (stage, engineLabel) => {
  const meta = STAGE_ORDER.find((s) => s.stage === stage);
  return `${meta ? meta.label : 'Stage'} — ${engineLabel}`;
};
