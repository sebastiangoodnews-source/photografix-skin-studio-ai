import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { smallPortrait, engineContext } from './helpers.js';
import { WorkflowSession } from '../src/core/workflow/orchestrator.js';
import { collectNames, validateLayerTree } from '../src/core/layers/record.js';
import { maskToRGBA } from '../src/core/masks/masks.js';
import { photoshopBlendName } from '../src/core/layers/render.js';
import { PHOTOSHOP_BLEND_NAMES, MODES } from '../src/core/image/blend.js';
import { PhotoshopLayerManager, adjustmentDescriptor, LAYER_LIMITS, buildStageRecords } from '../src/photoshop/layerManager.js';
import { probeHost, HOST_STATE, batchPlay, requireDocument } from '../src/photoshop/api.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Photoshop bridge tests.
 *
 * SCOPE, stated plainly: this suite proves the translation layer is correct. It
 * does NOT and cannot prove the plugin has been run inside Photoshop - there is no
 * host in this environment. Everything below either inspects pure data (layer
 * records, descriptors, masks) or asserts that the bridge FAILS CLEANLY when no
 * host is present. Any claim of "tested in Photoshop" would require executing it in
 * Photoshop, which has not happened.
 */

test('host probing reports "unavailable" honestly outside Photoshop', () => {
  const probe = probeHost();
  assert.equal(probe.available, false);
  assert.equal(probe.state, HOST_STATE.UNAVAILABLE);
  assert.match(String(probe.reason), /Photoshop|UXP/i);
});

test('host calls fail with a clear message instead of silently no-opping', async () => {
  assert.throws(() => requireDocument(), /Photoshop|document/i);
  await assert.rejects(() => batchPlay([{ _obj: 'get', _target: [{ _ref: 'document' }] }]), /Photoshop|UXP|host/i);
});

test('the layer manager refuses to run without a host rather than pretending', async () => {
  const manager = new PhotoshopLayerManager();
  await assert.rejects(() => manager.runPipeline([]), /Photoshop/i);
});

test('no Photoshop test claim is made anywhere in the shipped configuration', () => {
  const manifest = JSON.parse(readFileSync(join(here, '..', 'manifest.json'), 'utf8'));
  const blob = JSON.stringify(manifest).toLowerCase();
  assert.equal(blob.includes('tested in photoshop'), false);
  assert.equal(blob.includes('verified in photoshop'), false);
  // the id and host requirements must be the documented ones
  assert.equal(manifest.id, 'com.photografix.skinstudio');
  assert.equal(manifest.name, 'Photografix Skin Studio AI');
});

test('every engine blend mode has a Photoshop translation', () => {
  // every mode the renderer can composite must have a Photoshop counterpart, or the
  // committed layer would not match the preview
  const modes = Object.keys(MODES);
  for (const mode of modes) {
    const mapped = photoshopBlendName(mode);
    assert.equal(typeof mapped, 'string');
    assert.ok(mapped.length > 0, `${mode} has no Photoshop name`);
    if (mode !== 'normal') assert.notEqual(mapped, 'normal', `${mode} silently fell back to normal`);
    // and nothing may fall through to the default
    assert.equal(mapped, PHOTOSHOP_BLEND_NAMES[mode], `${mode} is missing from the translation table`);
  }
});

test('mask conversion produces a valid 8-bit RGBA buffer at document size', () => {
  const mask = new Float32Array(16);
  mask[5] = 1;
  const rgba = maskToRGBA(mask);
  assert.equal(rgba.length, 16 * 4);
  assert.equal(rgba[5 * 4 + 3], 255, 'opaque where the mask is 1');
  assert.equal(rgba[4], 0, 'transparent where the mask is 0');
  assert.equal(rgba[0], 0);
});

test('every adjustment an engine emits has a real Photoshop descriptor', () => {
  const frame = smallPortrait('rich-chocolate');
  const session = new WorkflowSession({});
  session.setDocument(frame);
  const engines = ['frequency-separation-professional', 'skin-tone', 'colour-grading', 'glossy-skin', 'final-review'];
  const tools = ['frequency', 'skinTone', 'colourGrading', 'glossySkin', 'review'];
  const adjustments = [];
  engines.forEach((engineId, i) => {
    const stage = session.runStage({ engineId, tool: tools[i] });
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.type === 'adjustment') adjustments.push(n.adjustment);
        if (n.type === 'group') walk(n.children);
      }
    };
    walk(stage.layers);
  });
  assert.ok(adjustments.length > 0, 'no adjustment layers were produced at all');
  for (const adj of adjustments) {
    const desc = adjustmentDescriptor(adj);
    assert.ok(desc, `no descriptor for adjustment type "${adj.type}"`);
    assert.equal(typeof desc._obj, 'string');
  }
});

test('adjustment descriptors carry units Photoshop requires', () => {
  const curves = adjustmentDescriptor({ type: 'curves', luma: [[0, 0], [128, 140], [255, 255]] });
  assert.equal(curves._obj, 'curves');
  const point = curves.adjustment[0].curve[1];
  assert.equal(point.horizontal._unit, 'percentUnit');
  assert.equal(point.vertical._unit, 'percentUnit');
  assert.ok(point.vertical._value > 50 && point.vertical._value < 60);

  const levels = adjustmentDescriptor({ type: 'levels', inBlack: 5, inWhite: 250, gamma: 1.1 });
  assert.equal(levels.adjustment[0].input[0]._unit, 'levelsUnit');
  assert.equal(levels.adjustment[0].gamma._unit, 'doubleValueUnit');
});

test('layer records stay inside the documented creation limits', () => {
  const frame = smallPortrait('rich-chocolate');
  const session = new WorkflowSession({});
  session.setDocument(frame);
  for (const [engineId, tool] of [
    ['frequency-separation-professional', 'frequency'],
    ['micro-dodge-burn', 'microDodgeBurn'],
    ['sculpt-dodge-burn', 'sculptDodgeBurn'],
    ['skin-tone', 'skinTone'],
    ['colour-grading', 'colourGrading'],
    ['glossy-skin', 'glossySkin'],
    ['final-review', 'review'],
  ]) {
    session.runStage({ engineId, tool });
  }
  const stack = session.layerStack();
  const total = stack.reduce((acc, g) => {
    let n = 0;
    const walk = (nodes) => nodes.forEach((x) => { n++; if (x.children) walk(x.children); });
    walk([g]);
    return acc + n;
  }, 0);
  assert.ok(total < LAYER_LIMITS.maxLayersPerRun, `full workflow makes ${total} layers, limit is ${LAYER_LIMITS.maxLayersPerRun}`);
  // every name is unique once collected, so Photoshop will not merge anything
  const names = collectNames(stack);
  assert.equal(new Set(names).size, names.length, 'duplicate layer names would confuse the build');
});

test('stage records keep the settings record hidden and non-destructive', () => {
  const records = buildStageRecords({
    stageLabel: 'Stage 1',
    layerRecords: [],
    settings: { blurRadius: 6 },
    engineId: 'frequency-separation-normal',
  });
  assert.equal(records.length, 1);
  const wrapper = records[0];
  assert.equal(wrapper.type, 'group');
  assert.equal(validateLayerTree(records).ok, true);
  const settingsLayer = wrapper.children.find((c) => /Settings/.test(c.name));
  assert.ok(settingsLayer, 'settings record missing');
  assert.equal(settingsLayer.visible, false, 'the settings record must start hidden');
  assert.match(settingsLayer.note, /frequency-separation-normal/);
});

test('layer trees from every engine survive the record contract Photoshop consumes', () => {
  const frame = smallPortrait('golden-brown');
  const engines = [
    ['requency', 'frequency-separation-normal'],
  ];
  void engines;
  const cases = [
    ['frequency-separation-normal', 'frequency'],
    ['frequency-separation-advanced', 'frequency'],
    ['frequency-separation-professional', 'frequency'],
    ['micro-dodge-burn', 'microDodgeBurn'],
    ['sculpt-dodge-burn', 'sculptDodgeBurn'],
    ['skin-tone', 'skinTone'],
    ['colour-grading', 'colourGrading'],
    ['glossy-skin', 'glossySkin'],
    ['final-review', 'review'],
  ];
  for (const [engineId, tool] of cases) {
    const registry = engineContext(frame);
    void registry;
    const session = new WorkflowSession({});
    session.setDocument(frame);
    const stage = session.runStage({ engineId, tool });
    assert.equal(validateLayerTree(stage.layers).ok, true, `${engineId}: invalid layer tree`);
    for (const group of stage.layers) {
      // Photoshop needs a top-level group per stage: engines never flatten
      assert.equal(group.type, 'group', `${engineId}: top level must be a group`);
      for (const child of group.children) {
        assert.ok(child.name && child.name.length < 120, `${engineId}: layer name unusable`);
        if (child.type === 'pixel') assert.ok(child.frame.width === frame.width);
        if (child.mask) assert.ok(child.mask instanceof Float32Array && child.mask.length === frame.pixelCount);
        assert.ok(child.opacity >= 0 && child.opacity <= 100);
      }
    }
  }
});
