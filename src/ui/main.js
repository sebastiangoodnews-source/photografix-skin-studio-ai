import { WorkflowSession } from '../core/workflow/orchestrator.js';
import { defaultRegistry, EngineRegistry } from '../core/engines/registry.js';
import { RegionResolver } from '../core/regions/zones.js';
import { PreviewView } from './preview.js';
import { PanelController, PANEL_DEFS } from './panel.js';
import { el } from './schemaUI.js';
import { CORE_SCHEMA, VERSION } from '../config/settings.js';
import { STAGE_ORDER } from '../config/presets.js';
import { probeHost, documentInfo, executeAsModal, getPhotoshop } from '../photoshop/api.js';
import { captureDocument } from '../photoshop/capture.js';
import { PhotoshopLayerManager } from '../photoshop/layerManager.js';
import { createPortrait } from '../../tools/lib/portrait.js';
import { createLogger, setLogLevel } from '../core/util/log.js';

const log = createLogger('panel');

/**
 * Panel bootstrap.
 *
 * Runs unchanged in two environments:
 *  - inside Photoshop (UXP): captures the live document and commits real layers;
 *  - in a browser (design review / automated UI smoke tests): renders a synthetic
 *    portrait so every control can be exercised without a host.
 *
 * The session layer is identical in both, which is what keeps previews honest.
 */

const state = {
  session: null,
  registry: defaultRegistry,
  resolver: null,
  preview: null,
  panels: null,
  host: null,
  mode: 'browser',
  busy: false,
};

const toast = (message, kind = 'info') => {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.remove('toast--error');
  if (kind === 'error') node.classList.add('toast--error');
  node.classList.add('toast--visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => node.classList.remove('toast--visible'), kind === 'error' ? 5200 : 2600);
};

const setStatus = (text) => {
  const node = document.getElementById('footer-status');
  if (node) node.textContent = text;
};

const setBusy = (busy, label = '') => {
  state.busy = busy;
  document.querySelectorAll('.btn--primary').forEach((b) => {
    b.disabled = busy;
  });
  if (busy) setStatus(label || 'Working…');
};

const boot = async () => {
  setLogLevel('warn');
  document.getElementById('app-version').textContent = VERSION;
  state.host = probeHost();
  state.registry = new EngineRegistry();
  state.resolver = new RegionResolver({});
  state.session = new WorkflowSession({ registry: state.registry, resolver: state.resolver });
  state.preview = new PreviewView(document.getElementById('preview-canvas'));

  buildTabs();
  state.panels = new PanelController({
    registry: state.registry,
    session: state.session,
    onRun: handleRun,
    onPreview: handlePreview,
    onReset: handleReset,
    notify: (msg) => toast(msg),
  });
  state.panels.render(document.getElementById('panels'));

  bindPreviewControls();
  bindGlobalControls();
  buildCoreSettings();

  await loadDocument();
};

const buildTabs = () => {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  for (const def of PANEL_DEFS) {
    const btn = el('button', { class: 'tab', type: 'button', role: 'tab', 'data-panel': def.id });
    btn.appendChild(el('span', { class: 'tab__step' }, String(def.stage)));
    btn.appendChild(el('span', {}, def.label));
    btn.addEventListener('click', () => state.panels.showPanel(def.id));
    tabs.appendChild(btn);
  }
};

const buildCoreSettings = () => {
  const host = document.getElementById('doc-section');
  // Re-analysis must not append a second copy of the safeguard sliders.
  host.querySelectorAll('.core-settings').forEach((node) => node.remove());
  const details = el('details', { class: 'core-settings' });
  details.appendChild(el('summary', {}, 'Engine safeguards'));
  const wrap = el('div', { class: 'core-settings__body' });
  const rows = [
    { id: 'protectIdentity', label: 'Identity protection', min: 0, max: 100, value: 85 },
    { id: 'highlightSafety', label: 'Highlight clipping safety', min: 0, max: 100, value: 90 },
    { id: 'shadowSafety', label: 'Shadow crush safety', min: 0, max: 100, value: 80 },
    { id: 'maskFeather', label: 'Auto mask feather', min: 0, max: 40, value: 6 },
  ];
  for (const row of rows) {
    const field = el('label', { class: 'field' });
    field.appendChild(el('span', { class: 'field__label' }, row.label));
    const out = el('span', { class: 'field__value' }, `${row.value}`);
    field.appendChild(out);
    const input = el('input', { type: 'range', min: String(row.min), max: String(row.max), value: String(row.value) });
    input.addEventListener('input', () => {
      out.textContent = input.value;
      state.session.core[row.id] = Number(input.value);
    });
    field.appendChild(input);
    wrap.appendChild(field);
  }
  details.appendChild(wrap);
  host.appendChild(details);
};

const bindPreviewControls = () => {
  document.getElementById('toggle-compare').addEventListener('change', (e) => {
    state.preview.setCompare(e.target.checked);
    document.getElementById('preview-split').disabled = !e.target.checked;
  });
  document.getElementById('toggle-mask').addEventListener('change', (e) => {
    state.preview.setShowMask(e.target.checked);
  });
  document.getElementById('preview-split').addEventListener('input', (e) => {
    state.preview.setSplit(Number(e.target.value));
  });
};

const bindGlobalControls = () => {
  document.getElementById('btn-analyse').addEventListener('click', async () => {
    await loadDocument(true);
  });
  document.getElementById('btn-apply').addEventListener('click', commitToPhotoshop);
  document.getElementById('btn-reset-all').addEventListener('click', resetAll);
};

/** Capture (Photoshop) or synthesise (browser) the working document. */
const loadDocument = async (reanalyse = false) => {
  if (state.host.available) {
    try {
      const info = documentInfo();
      const capture = await captureDocument({ maxEdge: 1400 });
      state.session.setDocument(capture.frame, {
        name: info?.name,
        width: info?.width,
        height: info?.height,
        scale: capture.scale,
      });
      setHostBadge(`Photoshop ${state.host.version}`, 'ok');
      document.getElementById('doc-meta').textContent = `${info?.name || 'Document'} · ${info?.width}×${info?.height}px · preview ${capture.width}×${capture.height}`;
      state.mode = 'photoshop';
    } catch (err) {
      log.warn('capture failed', { error: err?.message });
      setHostBadge('Photoshop present, capture failed', 'warn');
      toast(`Document capture failed: ${err.message}`, 'error');
      loadSyntheticDocument();
    }
  } else {
    setHostBadge('Preview mode (no Photoshop host)', 'warn');
    loadSyntheticDocument();
  }
  state.resolver.clear();
  state.session.analysis = state.resolver.analyse(state.session.original);
  applyAnalysisToUI();
  refreshPreviewFromSession();
  setStatus(reanalyse ? 'Re-analysed' : 'Ready');
  renderWorkflow();
};

const loadSyntheticDocument = () => {
  const frame = createPortrait({ width: 360, height: 480, tone: 'rich-chocolate', seed: 99 });
  state.session.setDocument(frame, { name: 'Synthetic portrait (preview mode)', width: frame.width, height: frame.height });
  state.mode = 'browser';
  document.getElementById('doc-meta').textContent = 'Preview mode · synthetic portrait · open a document in Photoshop for real work';
};

const setHostBadge = (text, kind) => {
  const badge = document.getElementById('host-badge');
  badge.textContent = text;
  badge.className = `badge badge--${kind}`;
};

const applyAnalysisToUI = () => {
  const a = state.session.analysis;
  if (!a) return;
  const parts = [];
  parts.push(a.face?.found ? `Face: ${a.face.method} (${Math.round(a.face.confidence * 100)}%)` : 'Face: not detected');
  parts.push(a.body?.zonesPresent?.length ? `Body: ${a.body.zonesPresent.length} zones` : 'Body: none detected');
  const meta = document.getElementById('doc-meta');
  meta.textContent = `${meta.textContent.split(' · ')[0]} · ${parts.join(' · ')}`;
};

const refreshPreviewFromSession = () => {
  if (!state.session.hasDocument()) return;
  const pair = state.session.previewPair(900);
  const mask = state.session.stages.length ? state.session.lastMask : null;
  state.preview.setFrames({ before: pair.before, after: pair.after, mask });
};

const handlePreview = ({ panel, mode, settings }) => {
  if (!state.session.hasDocument()) return toast('Load a document first', 'error');
  try {
    const engineId = state.registry.forTool(panel.engineTool === undefined ? 'frequency' : panel.engineTool, mode)?.id;
    const engine = mode ? state.registry.forTool('frequency', mode) : state.registry.forTool(panel.engineTool);
    const analysis = state.session.analysis;
    const input = state.session.composite();
    const result = engine.run(input, settings, {
      analysis,
      resolver: state.resolver,
      core: state.session.core,
    });
    const maxEdge = 900;
    const before = state.session.original;
    const after = result.preview || input;
    const scale = Math.min(1, maxEdge / Math.max(before.width, before.height));
    const fit = (f) =>
      scale >= 0.999 ? f : f.resize(Math.max(1, Math.round(f.width * scale)), Math.max(1, Math.round(f.height * scale)));
    let mask = result.mask || null;
    if (mask && scale < 0.999) {
      const mw = Math.max(1, Math.round(before.width * scale));
      const mh = Math.max(1, Math.round(before.height * scale));
      const small = new Float32Array(mw * mh);
      for (let y = 0; y < mh; y++) {
        const sy = Math.min(before.height - 1, Math.floor(y / scale));
        for (let x = 0; x < mw; x++) {
          const sx = Math.min(before.width - 1, Math.floor(x / scale));
          small[y * mw + x] = mask[sy * before.width + sx];
        }
      }
      mask = small;
    }
    state.preview.setFrames({ before: fit(before), after: fit(after), mask });
    state.session.lastMask = result.mask || null;
    if (panel.id === 'glossy-skin' && result.analysis) showHighlightReport(result.analysis);
    setStatus(`Preview: ${panel.label}${mode ? ` · ${mode}` : ''}`);
  } catch (err) {
    log.error('preview failed', { error: err?.message });
    toast(`Preview failed: ${err.message}`, 'error');
  }
};

const showHighlightReport = (analysis) => {
  const node = document.querySelector('[data-highlight-report]');
  if (!node) return;
  node.innerHTML = '';
  node.appendChild(el('div', { class: 'mode-info__tagline' }, `Highlights placed on ${analysis.highlightsFound.length} areas`));
  if (analysis.highlightsSkipped?.length) {
    node.appendChild(
      el(
        'p',
        { class: 'mode-info__best' },
        `Skipped: ${analysis.highlightsSkipped.map((s) => `${s.id} (${s.reason})`).join(', ')}`,
      ),
    );
  }
};

const handleRun = ({ panel, mode, settings }) => {
  if (!state.session.hasDocument()) return toast('Load a document first', 'error');
  if (state.busy) return;
  try {
    setBusy(true, `Running ${panel.label}…`);
    const engineId = mode ? `frequency-separation-${mode}` : state.registry.forTool(panel.engineTool).id;
    const existing = state.session.latestStageForTool(engineId);
    let stage;
    if (existing) {
      // Re-running a stage updates it in place: the settings sliders stay truthful
      // and the layers above are recomputed rather than discarded.
      stage = state.session.updateStage(existing.id, settings);
      toast(`${panel.label} updated`);
    } else {
      stage = state.session.runStage({
        tool: panel.engineTool,
        engineId,
        mode,
        settings,
        label: `${panel.label}${mode ? ` — ${mode}` : ''}`,
      });
      toast(`${panel.label} applied`);
    }
    state.session.lastMask = stage.layers?.[0]?.children?.find((c) => c.mask)?.mask || null;
    refreshPreviewFromSession();
    renderWorkflow();
    state.panels.showReport(panel.id, buildReport(stage));
    if (panel.id === 'final-review') state.panels.setReviewChecks(panel.id, stage.report?.checks);
    setStatus(`${panel.label} applied · ${stage.elapsedMs ?? ''}${stage.elapsedMs ? 'ms' : ''}`);
  } catch (err) {
    log.error('stage failed', { error: err.message });
    toast(`Stage failed: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
};

const buildReport = (stage) => {
  const rep = stage.report || {};
  const out = {};
  if (rep.checks) {
    // Stage 7's detail lives in the dedicated safety panel; the generic report only
    // needs the summary line.
    out.alerts = rep.checks.alertCount ? `${rep.checks.alertCount} alert(s)` : 'none';
    out.texture = `${rep.checks.texture.lossPct.toFixed(0)}% below original`;
    out.lightness = `${rep.checks.melanin.deltaL > 0 ? '+' : ''}${rep.checks.melanin.deltaL.toFixed(1)} L*`;
    out.reviewedArea = `${rep.skinCoveragePct}% of frame`;
    out.layers = stage.layers?.[0]?.children?.length ?? 0;
    return out;
  }
  if (rep.mode) out.mode = rep.mode;
  if (rep.radius) out.radius = `${rep.radius}px`;
  if (rep.radii) out.radii = `${Math.round(rep.radii.base)}/${Math.round(rep.radii.structure)}/${Math.round(rep.radii.form)}px`;
  if (rep.areas) out.areas = `${rep.areas.length} highlight areas`;
  if (rep.skipped) out.skipped = rep.skipped;
  if (rep.light) out.light = rep.light;
  if (rep.category) out.category = rep.category;
  if (rep.style) out.style = rep.style;
  if (rep.melanin !== undefined) out.melanin = rep.melanin.toFixed(2);
  if (rep.look) out.look = rep.look;
  if (rep.preset) out.preset = rep.preset;
  if (rep.levels) out.levels = JSON.stringify(rep.levels);
  out.layers = stage.layers?.[0]?.children?.length ?? 0;
  return out;
};

const handleReset = ({ panel, mode }) => {
  const engineId = mode ? `frequency-separation-${mode}` : state.registry.forTool(panel.engineTool).id;
  const existing = state.session.latestStageForTool(engineId);
  if (existing) {
    state.session.removeStage(existing.id);
    refreshPreviewFromSession();
    renderWorkflow();
    toast(`${panel.label} reset`);
  }
};

const resetAll = () => {
  state.session.stages = [];
  state.session.invalidate();
  refreshPreviewFromSession();
  renderWorkflow();
  PANEL_DEFS.forEach((def) => state.panels.showReport(def.id, null));
  state.panels.setReviewChecks('final-review', null);
  toast('All stages reset — original image restored');
};

const renderWorkflow = () => {
  const list = document.getElementById('workflow-list');
  list.innerHTML = '';
  for (const stage of STAGE_ORDER) {
    const done = state.session.stages.filter((s) => s.stage === stage.stage);
    const li = el('li', { class: `workflow__item${done.length ? ' workflow__item--done' : ''}` });
    li.appendChild(el('span', { class: 'dot' }));
    li.appendChild(el('span', { class: 'grow' }, stage.label));
    li.appendChild(el('span', { class: 'meta' }, done.length ? `${done.length} run · ${done.reduce((a, s) => a + countLayers(s.layers), 0)} layers` : 'not run'));
    if (done.length) {
      const off = el('button', { type: 'button', title: 'Toggle this stage' }, '◐');
      off.addEventListener('click', () => {
        const stageEntry = done[0];
        state.session.setStageEnabled(stageEntry.id, !stageEntry.enabled);
        refreshPreviewFromSession();
        renderWorkflow();
      });
      li.appendChild(off);
    }
    list.appendChild(li);
  }
};

const countLayers = (nodes) => {
  let n = 0;
  for (const node of nodes || []) {
    n += 1;
    if (node.type === 'group') n += countLayers(node.children);
  }
  return n;
};

/** Commit the whole session as live Photoshop layer groups. */
const commitToPhotoshop = async () => {
  if (!state.host.available) {
    return toast('Open Photoshop to build layers — preview mode exports nothing', 'error');
  }
  if (!state.session.stages.length) return toast('Run at least one stage first', 'error');
  if (state.busy) return;
  try {
    setBusy(true, 'Building Photoshop layers…');
    const records = state.session.layerStack();
    const manager = new PhotoshopLayerManager();
    const result = await manager.runPipeline(records);
    const warnings = result.warnings.filter((w) => w.level === 'warn');
    toast(`Created ${result.created.length} layers${warnings.length ? ` · ${warnings.length} warning(s)` : ''}`);
    setStatus(`Committed ${result.created.length} layers to Photoshop`);
  } catch (err) {
    log.error('commit failed', { error: err.message });
    toast(`Layer build failed: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
};

if (typeof document !== 'undefined' && document.getElementById('app')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

export { boot, state };
