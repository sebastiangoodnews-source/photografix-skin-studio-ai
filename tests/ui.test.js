import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDocument, installGlobals, mountIndexHtml } from './support/dom.js';
import { PANEL_DEFS } from '../src/ui/panel.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');

/**
 * UI tests exercise the real panel code against the real index.html markup.
 *
 * They exist because the panel is the part that cannot be tested inside Node any
 * other way: a missing element id, a null listener or a broken schema render would
 * otherwise only show up when a retoucher opens the panel.
 */

const bootPanel = async () => {
  const doc = createDocument();
  mountIndexHtml(doc, indexHtml);
  installGlobals(doc);
  // fresh module graph per test so module-level state does not leak
  const main = await import(`../src/ui/main.js?t=${Math.random()}`);
  await main.boot();
  return { doc, main };
};

test('index.html carries every element the bootstrap looks up', async () => {
  const required = ['app', 'app-version', 'tabs', 'panels', 'preview-canvas', 'doc-meta', 'host-badge', 'toast', 'footer-status', 'doc-section', 'toggle-compare', 'toggle-mask', 'preview-split', 'btn-analyse', 'btn-apply', 'btn-reset-all', 'workflow-list'];
  for (const id of required) {
    assert.ok(new RegExp(`id="${id}"`).test(indexHtml), `index.html is missing #${id}`);
  }
  // no inline scripts: UXP CSP forbids them, everything must be an external module
  assert.equal(/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/.test(indexHtml), false, 'inline <script> blocks are not allowed under UXP CSP');
});

test('boot wires the panel without throwing and produces all seven stage tabs', async () => {
  const { doc, main } = await bootPanel();
  const tabs = doc.getElementById('tabs').querySelectorAll('.tab');
  assert.equal(tabs.length, 7, `expected 7 stage tabs, got ${tabs.length}`);
  assert.deepEqual(
    tabs.map((t) => t.dataset.panel),
    ['frequency', 'micro-dodge-burn', 'sculpt-dodge-burn', 'skin-tone', 'colour-grading', 'glossy-skin', 'final-review'],
  );
  // the seven-stage workflow list is what tells the retoucher where they are
  const workflow = doc.getElementById('workflow-list').querySelectorAll('.workflow__item');
  assert.equal(workflow.length, 7);
  assert.equal(main.state.session.hasDocument(), true, 'a document should be loaded on boot');
  assert.equal(main.state.panels.activePanel, 'frequency');
});

test('the document badge is honest about preview mode', async () => {
  const { doc } = await bootPanel();
  const badge = doc.getElementById('host-badge');
  assert.match(badge.textContent, /Preview mode/, 'must not claim a Photoshop host in a browser');
  // the analysis pass rewrites the meta line, so check the honest parts survive
  assert.match(doc.getElementById('doc-meta').textContent, /^Preview mode/);
});

test('every panel renders a form with its engine schema controls', async () => {
  const { doc, main } = await bootPanel();
  for (const def of PANEL_DEFS) {
    main.state.panels.showPanel(def.id);
    const panel = doc.querySelector(`section.panel[data-panel="${def.id}"]`);
    assert.ok(panel, `${def.id}: panel markup missing`);
    const inputs = panel.querySelectorAll('input');
    const selects = panel.querySelectorAll('select');
    assert.ok(inputs.length + selects.length > 3, `${def.id}: schema did not render controls (${inputs.length} inputs, ${selects.length} selects)`);
    const runBtn = panel.querySelectorAll('.btn').find((b) => /Apply/i.test(b.textContent));
    assert.ok(runBtn, `${def.id}: no apply button`);
  }
});

test('applying a stage through the UI updates the session, the preview and the workflow list', async () => {
  const { doc, main } = await bootPanel();
  const panel = doc.querySelector('section.panel[data-panel="frequency"]');
  const apply = panel.querySelectorAll('.btn').find((b) => /Apply/i.test(b.textContent));
  apply.click();
  assert.equal(main.state.session.stages.length, 1, 'the stage should have been committed to the session');
  assert.equal(main.state.session.stages[0].engineId, 'frequency-separation-normal');
  const done = doc.getElementById('workflow-list').querySelectorAll('.workflow__item--done');
  assert.equal(done.length, 1, 'the workflow checklist must mark stage 1 as done');
  assert.match(done[0].textContent, /Frequency Separation/);
  // the preview must now show a real before/after pair, not the placeholder
  assert.ok(main.state.preview.before, 'preview has no before frame');
  assert.ok(main.state.preview.after, 'preview has no after frame');
  assert.notEqual(main.state.preview.before, main.state.preview.after);
});

test('the frequency mode switcher swaps the schema and re-labels the run', async () => {
  const { doc, main } = await bootPanel();
  const panel = doc.querySelector('section.panel[data-panel="frequency"]');
  const modes = panel.querySelectorAll('.mode');
  assert.equal(modes.length, 3);
  modes[2].click();
  assert.equal(main.state.panels.mode, 'professional');
  assert.ok(modes[2].classList.contains('mode--active'));
  const apply = panel.querySelectorAll('.btn').find((b) => /Apply/i.test(b.textContent));
  apply.click();
  assert.equal(main.state.session.stages[0].engineId, 'frequency-separation-professional');
});

test('re-applying the same panel updates the existing stage instead of stacking duplicates', async () => {
  const { doc, main } = await bootPanel();
  const panel = doc.querySelector('section.panel[data-panel="micro-dodge-burn"]');
  const apply = panel.querySelectorAll('.btn').find((b) => /Apply/i.test(b.textContent));
  apply.click();
  apply.click();
  assert.equal(main.state.session.stages.length, 1, 'a re-run must update, not duplicate');
  assert.equal(main.state.session.stages[0].tool, 'microDodgeBurn');
});

test('reset removes only that panel stage and restores the original composite', async () => {
  const { doc, main } = await bootPanel();
  const panel = doc.querySelector('section.panel[data-panel="glossy-skin"]');
  const apply = panel.querySelectorAll('.btn').find((b) => /Apply/i.test(b.textContent));
  apply.click();
  assert.equal(main.state.session.stages.length, 1);
  const reset = panel.querySelectorAll('.btn').find((b) => /^Reset$/.test(b.textContent));
  reset.click();
  assert.equal(main.state.session.stages.length, 0);
  const original = main.state.session.original;
  const composite = main.state.session.composite();
  let max = 0;
  for (let i = 0; i < original.pixelCount; i++) max = Math.max(max, Math.abs(composite.r[i] - original.r[i]));
  assert.equal(max, 0, 'reset must return to the untouched original');
});

test('compare and mask toggles drive the preview view', async () => {
  const { doc, main } = await bootPanel();
  const compare = doc.getElementById('toggle-compare');
  compare.type('true', 'change');
  assert.equal(main.state.preview.compare, true);
  assert.equal(doc.getElementById('preview-split').disabled, false, 'split slider enables with compare');
  const mask = doc.getElementById('toggle-mask');
  mask.type('true', 'change');
  assert.equal(main.state.preview.showMask, true);
  const split = doc.getElementById('preview-split');
  split.type('72');
  assert.equal(main.state.preview.split, 0.72);
});

test('stage 7 renders the safety report with real measurements', async () => {
  const { doc, main } = await bootPanel();
  const panel = doc.querySelector('section.panel[data-panel="final-review"]');
  const apply = panel.querySelectorAll('.btn').find((b) => /Apply/i.test(b.textContent));
  apply.click();
  const report = doc.querySelector('[data-review-checks="final-review"]');
  assert.ok(report, 'the review panel has no checks container');
  const badge = report.querySelector('.review-badge');
  assert.ok(badge, 'no pass/fail badge');
  assert.match(badge.textContent, /PASS|issue/);
  const rows = report.querySelectorAll('.review-list').length ? report.querySelectorAll('.review-list')[0].querySelectorAll('dt') : [];
  assert.ok(rows.length >= 6, `expected at least six check rows, got ${rows.length}`);
  const labels = rows.map((r) => r.textContent);
  for (const expected of ['Texture', 'Skin lightness', 'Edge halo', 'Clipping', 'Face / neck', 'Face / body']) {
    assert.ok(labels.includes(expected), `missing check row "${expected}"`);
  }
  const stage = main.state.session.stages.at(-1);
  assert.equal(stage.engineId, 'final-review');
  assert.ok(stage.report.checks.melanin, 'the stage report must carry the checks');
});

test('core safeguard sliders write through to the session core settings', async () => {
  const { doc, main } = await bootPanel();
  const sliders = doc.getElementById('doc-section').querySelectorAll('input');
  assert.equal(sliders.length, 4, `four engine safeguards expected, got ${sliders.length}`);
  sliders[0].type('40');
  assert.equal(main.state.session.core.protectIdentity, 40);
  sliders[3].type('12');
  assert.equal(main.state.session.core.maskFeather, 12);

  // pressing Analyse again must not append a second copy of the sliders
  doc.getElementById('btn-analyse').click();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(doc.getElementById('doc-section').querySelectorAll('input').length, 4, 're-analysis duplicated the safeguard controls');
});

test('every schema control is bound and follows its declared range', async () => {
  const { doc, main } = await bootPanel();
  for (const def of PANEL_DEFS) {
    main.state.panels.showPanel(def.id);
    const panel = doc.querySelector(`section.panel[data-panel="${def.id}"]`);
    const entry = main.state.panels.forms.get(def.id);
    assert.ok(entry, `${def.id}: no form registered`);
    for (const param of entry.schema.params) {
      const node = panel.querySelector(`[data-param="${param.id}"]`);
      assert.ok(node, `${def.id}: no control for ${param.id}`);
      const control = node.querySelector('input') || node.querySelector('select');
      assert.ok(control, `${def.id}/${param.id}: control element missing`);
      if (param.type === 'range') {
        assert.equal(control.getAttribute('min'), String(param.min));
        assert.equal(control.getAttribute('max'), String(param.max));
        assert.equal(Number(control.value), param.default, `${def.id}/${param.id}: default not applied`);
      }
    }
  }
});
