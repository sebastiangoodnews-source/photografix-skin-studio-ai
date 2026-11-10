import { SchemaForm, el, defaultsFor } from './schemaUI.js';
import { FS_MODE_INFO, SCULPT_PRESETS, GLOSS_PRESETS, INTENSITY_OPTIONS } from '../config/presets.js';
import { SKIN_TONE_CATEGORIES, SKIN_TONE_STYLES } from '../core/engines/africanSkinPalette.js';
import { GRADE_LOOKS } from '../core/engines/colourGrading.js';

/**
 * Tool panels.
 *
 * One panel per stage; the Frequency Separation panel owns its three modes. Panels
 * are pure view: they render the engine schema, collect values and ask the
 * controller to run/preview/commit. Adding a parameter never requires touching UI
 * code, and no processing value is duplicated here.
 */

export const PANEL_DEFS = [
  {
    id: 'frequency',
    stage: 1,
    label: 'Frequency Separation',
    engineTool: 'frequency',
    description: 'Separate texture from colour, then retouch each independently. Choose the mode that matches the work.',
    modes: ['normal', 'advanced', 'professional'],
    extras: ['modeInfo', 'previewBeforeAfter'],
  },
  {
    id: 'micro-dodge-burn',
    stage: 2,
    label: 'Micro Dodge & Burn',
    engineTool: 'microDodgeBurn',
    description: 'Correct small tonal distractions - patchiness, stray shadows, under-eye darkness - on face and body. Not a shaping tool.',
    extras: ['brushInfo'],
  },
  {
    id: 'sculpt-dodge-burn',
    stage: 3,
    label: 'Sculpt Dodge & Burn',
    engineTool: 'sculptDodgeBurn',
    description: 'Build form and dimension with light, following the photograph\'s own key light. Never changes body proportions.',
    extras: ['presets', 'brushInfo'],
  },
  {
    id: 'skin-tone',
    stage: 4,
    label: 'African Skin Tone Studio',
    engineTool: 'skinTone',
    description: 'Melanin-aware complexion work: palette matching, face-to-neck and face-to-body harmony, and editable skin styles.',
    extras: ['palette'],
  },
  {
    id: 'colour-grading',
    stage: 5,
    label: 'Colour Grading',
    engineTool: 'colourGrading',
    description: 'Cinematic, wedding and Photografix signature grades, masked off the skin so the complexion survives any look.',
    extras: ['looks'],
  },
  {
    id: 'glossy-skin',
    stage: 6,
    label: 'Photografix Glossy Skin',
    engineTool: 'glossySkin',
    description: 'Intelligent highlights, skin glow, lip enhancement and contour light - only where the photograph\'s lighting allows.',
    extras: ['presets', 'highlightReport'],
  },
  {
    id: 'final-review',
    stage: 7,
    label: 'Final Review',
    engineTool: 'review',
    description: 'The safety net. Objective checks on texture, tone, edges and exposure, plus the last finishing moves - all additive, so nothing you already did can be lost.',
    extras: ['reviewChecks'],
  },
];

export class PanelController {
  constructor({ registry, session, onRun, onPreview, onReset, notify }) {
    this.registry = registry;
    this.session = session;
    this.onRun = onRun;
    this.onPreview = onPreview;
    this.onReset = onReset;
    this.notify = notify || (() => {});
    this.activePanel = PANEL_DEFS[0].id;
    this.mode = 'normal';
    this.forms = new Map();
    this.panelElements = new Map();
  }

  render(container) {
    container.innerHTML = '';
    for (const def of PANEL_DEFS) {
      const panelEl = this.renderPanel(def);
      this.panelElements.set(def.id, panelEl);
      container.appendChild(panelEl);
    }
    this.showPanel(this.activePanel);
  }

  renderPanel(def) {
    const panel = el('section', { class: 'panel', 'data-panel': def.id });
    const head = el('div', { class: 'panel__head' });
    const titleWrap = el('div', {});
    titleWrap.appendChild(el('div', { class: 'panel__step' }, `Stage ${def.stage} of 7`));
    titleWrap.appendChild(el('h2', { class: 'panel__title' }, def.label));
    head.appendChild(titleWrap);
    const resetBtn = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Reset');
    resetBtn.addEventListener('click', () => this.resetPanel(def));
    head.appendChild(resetBtn);
    panel.appendChild(head);
    panel.appendChild(el('p', { class: 'panel__desc' }, def.description));

    if (def.modes) panel.appendChild(this.renderModes(def));

    const formHost = el('div', { class: 'form-host' });
    panel.appendChild(formHost);

    panel.appendChild(this.renderExtras(def));

    const actions = el('div', { class: 'actions' });
    const previewBtn = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Preview');
    previewBtn.addEventListener('click', () => this.previewCurrent(def));
    const runBtn = el('button', { class: 'btn btn--primary', type: 'button' }, 'Apply stage');
    runBtn.addEventListener('click', () => this.runCurrent(def));
    actions.appendChild(runBtn);
    actions.appendChild(previewBtn);
    panel.appendChild(actions);

    const report = el('div', { class: 'report', 'data-report': def.id });
    panel.appendChild(report);

    this.formHosts = this.formHosts || new Map();
    this.formHosts.set(def.id, formHost);
    this.renderForm(def);
    return panel;
  }

  renderModes(def) {
    const wrap = el('div', { class: 'modes', role: 'tablist' });
    for (const mode of def.modes) {
      const btn = el('button', { class: 'mode', type: 'button', 'data-mode': mode, role: 'tab' }, FS_MODE_INFO[mode].label);
      btn.addEventListener('click', () => {
        this.mode = mode;
        this.updateModeButtons(def.id);
        this.renderForm(def);
        this.notify(`${FS_MODE_INFO[mode].label}: ${FS_MODE_INFO[mode].tagline}`, 'info');
      });
      wrap.appendChild(btn);
    }
    setTimeout(() => this.updateModeButtons(def.id), 0);
    return wrap;
  }

  updateModeButtons(panelId) {
    // Scope to section.panel: the tab button carries the same data-panel attribute,
    // so a bare attribute selector would resolve to the tab in the nav bar.
    const panel = this.panelElements.get(panelId) || document.querySelector(`section.panel[data-panel="${panelId}"]`);
    if (!panel) return;
    panel.querySelectorAll('.mode').forEach((btn) => {
      btn.classList.toggle('mode--active', btn.dataset.mode === this.mode);
    });
    const info = panel.querySelector('[data-mode-info]');
    if (info) {
      const meta = FS_MODE_INFO[this.mode];
      info.innerHTML = '';
      info.appendChild(el('div', { class: 'mode-info__tagline' }, meta.tagline));
      info.appendChild(el('p', { class: 'mode-info__desc' }, meta.description));
      info.appendChild(el('p', { class: 'mode-info__best' }, `Best for: ${meta.bestFor}`));
    }
  }

  renderExtras(def) {
    const wrap = el('div', { class: 'extras' });
    if (def.extras?.includes('modeInfo')) {
      wrap.appendChild(el('div', { class: 'mode-info', 'data-mode-info': '' }));
      setTimeout(() => this.updateModeButtons(def.id), 0);
    }
    if (def.extras?.includes('palette')) wrap.appendChild(this.renderPaletteInfo());
    if (def.extras?.includes('looks')) wrap.appendChild(this.renderLooksInfo());
    if (def.extras?.includes('highlightReport')) wrap.appendChild(el('div', { class: 'mode-info', 'data-highlight-report': '' }));
    if (def.extras?.includes('reviewChecks')) wrap.appendChild(this.renderReviewChecks(def));
    return wrap;
  }

  renderPaletteInfo() {
    const wrap = el('div', { class: 'mode-info' });
    wrap.appendChild(
      el('div', { class: 'mode-info__tagline' }, `${SKIN_TONE_CATEGORIES.length} tone categories · ${SKIN_TONE_STYLES.length} editable styles`),
    );
    const list = el('div', { class: 'palette-strip' });
    const canvas = el('canvas', { class: 'palette-canvas', width: String(SKIN_TONE_CATEGORIES.length * 16), height: '18' });
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (ctx) {
      SKIN_TONE_CATEGORIES.forEach((c, i) => {
        ctx.fillStyle = labToCss(c.lab);
        ctx.fillRect(i * 16, 0, 15, 18);
      });
    }
    list.appendChild(canvas);
    wrap.appendChild(list);
    wrap.appendChild(
      el('p', { class: 'mode-info__best' }, 'Colour-style categories, not classifications: pick one, then fine-tune with the sliders.'),
    );
    return wrap;
  }

  renderLooksInfo() {
    const wrap = el('div', { class: 'mode-info' });
    const families = new Map();
    for (const look of GRADE_LOOKS) {
      if (!families.has(look.family)) families.set(look.family, []);
      families.get(look.family).push(look.label);
    }
    for (const [family, looks] of families) {
      wrap.appendChild(el('div', { class: 'mode-info__tagline' }, `${family}: ${looks.length} grades`));
    }
    return wrap;
  }

  renderForm(def) {
    const host = this.formHosts.get(def.id);
    if (!host) return;
    host.innerHTML = '';
    const schema = this.schemaFor(def);
    const existing = this.session.latestStageForTool(def.id === 'frequency' ? `frequency-separation-${this.mode}` : def.engineTool);
    const form = new SchemaForm({
      schema,
      values: existing?.settings || defaultsFor(schema),
      onChange: () => {},
      onCommit: () => this.previewCurrent(def),
    });
    host.appendChild(form.render());
    this.forms.set(def.id, { form, def, schema });
  }

  schemaFor(def) {
    if (def.id === 'frequency') {
      const engine = this.registry.forTool('frequency', this.mode);
      return engine.schema;
    }
    return this.registry.forTool(def.engineTool).schema;
  }

  currentValues(def) {
    const entry = this.forms.get(def.id);
    return entry ? entry.form.getValues() : {};
  }

  previewCurrent(def) {
    const values = this.currentValues(def);
    this.onPreview({ panel: def, mode: def.id === 'frequency' ? this.mode : null, settings: values });
  }

  runCurrent(def) {
    const values = this.currentValues(def);
    this.onRun({ panel: def, mode: def.id === 'frequency' ? this.mode : null, settings: values });
  }

  resetPanel(def) {
    const entry = this.forms.get(def.id);
    if (!entry) return;
    entry.form.setValues(defaultsFor(entry.schema));
    if (def.id === 'final-review') this.setReviewChecks(def.id, null);
    this.onReset({ panel: def, mode: def.id === 'frequency' ? this.mode : null });
  }

  showPanel(id) {
    this.activePanel = id;
    for (const [panelId, panelEl] of this.panelElements) {
      panelEl.style.display = panelId === id ? '' : 'none';
    }
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('tab--active', tab.dataset.panel === id);
    });
  }

  /**
   * Safety-check panel for stage 7. Rendered from the engine report, so the numbers
   * on screen are the numbers the checks actually computed - there is no second
   * implementation of "is this image safe" anywhere in the UI.
   */
  renderReviewChecks(def) {
    const host = el('div', { class: 'mode-info review-checks', 'data-review-checks': def.id });
    this.reviewHosts = this.reviewHosts || new Map();
    this.reviewHosts.set(def.id, host);
    this.setReviewChecks(def.id, null);
    return host;
  }

  setReviewChecks(panelId, checks) {
    const host = this.reviewHosts?.get(panelId);
    if (!host) return;
    host.innerHTML = '';
    if (!checks) {
      host.appendChild(el('div', { class: 'mode-info__tagline' }, 'Run Final Review to see the safety report'));
      host.appendChild(el('p', { class: 'mode-info__best' }, 'Texture loss, melanin drift, edge halos, clipping and face/body colour matching are all measured against the original.'));
      return;
    }
    const badge = el(
      'div',
      { class: `review-badge${checks.pass ? ' review-badge--pass' : ' review-badge--fail'}` },
      checks.pass ? 'PASS — no high-priority issues' : `${checks.alerts.filter((a) => a.level === 'high').length} high-priority issue(s)`,
    );
    host.appendChild(badge);

    const rows = [
      ['Texture', `${checks.texture.lossPct.toFixed(0)}% below original`, checks.texture.plasticRisk === 'low' ? 'ok' : checks.texture.plasticRisk],
      ['Skin lightness', `${checks.melanin.before.toFixed(1)} → ${checks.melanin.after.toFixed(1)} L* (${checks.melanin.direction})`, checks.melanin.direction === 'stable' ? 'ok' : 'warn'],
      ['Edge halo', checks.halo.found ? `${checks.halo.maxDelta.toFixed(0)} levels on ${checks.halo.side}` : 'none introduced', checks.halo.found ? 'warn' : 'ok'],
      ['Clipping', `${checks.exposure.clippedPct.toFixed(1)}% clipped · ${checks.exposure.crushedPct.toFixed(1)}% crushed`, checks.exposure.clippedPct > 0.5 || checks.exposure.crushedPct > 0.5 ? 'warn' : 'ok'],
      ['Face / neck', `${checks.matching.faceNeck.deltaChroma.toFixed(1)} chroma`, checks.matching.faceNeck.deltaChroma > 8 ? 'warn' : 'ok'],
      ['Face / body', `${checks.matching.faceBody.deltaL.toFixed(1)} L*`, Math.abs(checks.matching.faceBody.deltaL) > 6 ? 'warn' : 'ok'],
    ];
    const list = el('dl', { class: 'review-list' });
    for (const [label, value, state] of rows) {
      list.appendChild(el('dt', {}, label));
      list.appendChild(el('dd', { class: `review-${state}` }, value));
    }
    host.appendChild(list);

    if (checks.alerts.length) {
      const alerts = el('ul', { class: 'review-alerts' });
      for (const alert of checks.alerts) {
        alerts.appendChild(el('li', { class: `review-alert review-alert--${alert.level}` }, alert.message));
      }
      host.appendChild(alerts);
    }
  }

  showReport(panelId, data) {
    const elReport = document.querySelector(`[data-report="${panelId}"]`);
    if (!elReport) return;
    elReport.innerHTML = '';
    if (!data || typeof data !== 'object') {
      elReport.classList.remove('report--visible');
      return;
    }
    const dl = el('dl');
    for (const [k, v] of Object.entries(data)) {
      dl.appendChild(el('dt', {}, humanise(k)));
      dl.appendChild(el('dd', {}, Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }
    elReport.appendChild(dl);
    elReport.classList.add('report--visible');
  }
}

const humanise = (key) =>
  key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();

const labToCss = (lab) => {
  // small local Lab -> sRGB for the palette strip swatches
  const { L, a, b } = lab;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047;
  const Y = inv(fy);
  const Z = inv(fz) * 1.08883;
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ].map((v) => {
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  });
  return `rgb(${lin.join(',')})`;
};

export const PRESET_HINTS = {
  intensity: INTENSITY_OPTIONS,
  sculpt: SCULPT_PRESETS,
  gloss: GLOSS_PRESETS,
};
