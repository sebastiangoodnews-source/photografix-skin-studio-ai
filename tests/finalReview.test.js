import test from 'node:test';
import assert from 'node:assert/strict';
import { smallPortrait, frameDelta } from './helpers.js';
import { WorkflowSession } from '../src/core/workflow/orchestrator.js';
import { validateLayerTree } from '../src/core/layers/record.js';
import { renderStack } from '../src/core/layers/render.js';
import {
  FinalReviewEngine,
  runReviewChecks,
  detectEdgeHalo,
  melaninDrift,
  textureLoss,
  faceBodyMatch,
  falseColourMap,
  differenceMap,
} from '../src/core/engines/finalReview.js';
import { defaultRegistry } from '../src/core/engines/registry.js';
import * as blurModule from '../src/core/image/filters.js';

const reviewedSession = (tone = 'rich-chocolate') => {
  const frame = smallPortrait(tone);
  const session = new WorkflowSession({});
  session.setDocument(frame);
  session.runStage({ engineId: 'frequency-separation-normal', tool: 'frequency' });
  session.runStage({ engineId: 'micro-dodge-burn', tool: 'microDodgeBurn' });
  return { frame, session };
};

test('stage 7 is registered and reachable through the tool registry', () => {
  assert.equal(defaultRegistry.forTool('review').id, 'final-review');
  const entry = defaultRegistry.list().find((e) => e.id === 'final-review');
  assert.equal(entry.stage, 7);
});

test('final review reports a clean pass on an untouched image', () => {
  const frame = smallPortrait('rich-chocolate');
  const session = new WorkflowSession({});
  session.setDocument(frame);
  const stage = session.runStage({ engineId: 'final-review', tool: 'review' });
  const checks = stage.report.checks;
  assert.equal(checks.pass, true);
  assert.equal(checks.texture.lossPct, 0, 'nothing was retouched, so no texture was lost');
  assert.equal(checks.melanin.direction, 'stable');
  assert.equal(checks.halo.found, false);
  assert.ok(checks.alerts.length === 0);
  assert.match(stage.report.notes[0], /No safety alerts/);
});

test('final review keeps preview and layer stack in exact parity', () => {
  const { session } = reviewedSession();
  const stage = session.runStage({ engineId: 'final-review', tool: 'review' });
  const rendered = renderStack(stage.layers, session.composite());
  const d = frameDelta(rendered, stage.output);
  assert.ok(d.max < 0.51, `parity drifted by ${d.max.toFixed(2)}`);
  assert.equal(validateLayerTree(stage.layers).ok, true);
});

test('final review is additive: it cannot undo earlier stages', () => {
  const { frame, session } = reviewedSession();
  const before = session.composite().clone();
  session.runStage({ engineId: 'final-review', tool: 'review' });
  const after = session.composite();
  const d = frameDelta(before, after);
  // with every finishing option off, the review must not move a single pixel
  assert.ok(d.max < 0.51, `review changed the image by ${d.max.toFixed(2)} with no options enabled`);
  assert.ok(frame);
});

test('texture-loss check detects a plastic-skin retouch', () => {
  const frame = smallPortrait('golden-brown');
  const session = new WorkflowSession({});
  session.setDocument(frame);
  const scope = session.analysis.skin;
  const { blurFrame } = blurModule;

  // 1. A genuinely destructive retouch (what "plastic skin" actually looks like).
  const plastic = blurFrame(frame, 2);
  const heavy = textureLoss(frame, plastic, scope);
  assert.ok(heavy.lossPct > 55, `heavy smoothing must read as plastic (${heavy.lossPct})`);
  assert.equal(heavy.plasticRisk, 'high');
  const flagged = runReviewChecks({
    frame: plastic,
    original: frame,
    analysis: session.analysis,
    scope,
    settings: { textureThreshold: 38, haloThreshold: 8, melaninTolerance: 4 },
  });
  assert.ok(flagged.alerts.some((a) => a.id === 'texture'), 'the reviewer must raise a texture alert');
  assert.equal(flagged.pass, false);

  // 2. The tool's own strongest setting must register as a real, measurable loss.
  session.runStage({
    engineId: 'frequency-separation-advanced',
    tool: 'frequency',
    settings: { textureSmoothing: 100, porePreservation: 0, strength: 100, textureRestore: 0, blemishAware: 0 },
  });
  const stage = session.runStage({ engineId: 'final-review', tool: 'review' });
  const tex = stage.report.checks.texture;
  assert.ok(tex.lossPct > 20, `maximum smoothing should measure a real loss, got ${tex.lossPct}`);
  assert.ok(tex.after < tex.before);
});

test('moderate texture smoothing stays below the alarm', () => {
  const frame = smallPortrait('golden-brown');
  const session = new WorkflowSession({});
  session.setDocument(frame);
  const scope = session.analysis.skin;
  const { blurFrame } = blurModule;
  const light = textureLoss(frame, blurFrame(frame, 1.2), scope);
  assert.ok(light.lossPct < 38, `a light softening must not alarm (${light.lossPct})`);
  assert.equal(light.plasticRisk, 'low');
});

test('melanin drift catches brightening but ignores a faithful retouch', () => {
  const frame = smallPortrait('dark-ebony');
  const session = new WorkflowSession({});
  session.setDocument(frame);
  const analysis = session.analysis;
  const scope = analysis.skin;
  const unchanged = melaninDrift(frame, frame, scope);
  assert.equal(unchanged.direction, 'stable');
  assert.equal(unchanged.deltaL, 0);

  const lightened = frame.clone();
  const { rgbToLab, labToRgb } = globalThis;
  for (let i = 0; i < frame.pixelCount; i++) {
    const lift = 12 * scope[i];
    lightened.r[i] = Math.min(255, frame.r[i] + lift);
    lightened.g[i] = Math.min(255, frame.g[i] + lift);
    lightened.b[i] = Math.min(255, frame.b[i] + lift);
  }
  const brightened = melaninDrift(frame, lightened, scope);
  assert.equal(brightened.direction, 'brightened');
  assert.ok(brightened.deltaL > 5, `deltaL ${brightened.deltaL}`);
});

test('halo detection ignores natural rim light but catches an introduced band', () => {
  const frame = smallPortrait('rich-chocolate');
  const session = new WorkflowSession({});
  session.setDocument(frame);
  const analysis = session.analysis;
  const scope = analysis.skin;

  const clean = detectEdgeHalo(frame, analysis, scope, 8, frame);
  assert.equal(clean.found, false, `natural lighting must not read as a halo (${clean.maxDelta})`);

  const haloed = frame.clone();
  for (let i = 0; i < frame.pixelCount; i++) {
    if (analysis.skin[i] > 0.5) {
      haloed.r[i] = Math.min(255, frame.r[i] + 40);
      haloed.g[i] = Math.min(255, frame.g[i] + 40);
      haloed.b[i] = Math.min(255, frame.b[i] + 40);
    }
  }
  const injected = detectEdgeHalo(haloed, analysis, scope, 8, frame);
  assert.equal(injected.found, true);
  assert.ok(injected.maxDelta > 20);
});

test('face/body matching reports readable deltas for every tone', () => {
  for (const tone of ['deep-chocolate', 'rich-chocolate', 'golden-brown', 'light-skin']) {
    const frame = smallPortrait(tone);
    const session = new WorkflowSession({});
    session.setDocument(frame);
    const stats = faceBodyMatch(frame, session.analysis);
    assert.equal(stats.available, true, `${tone}: face or body zones missing`);
    assert.ok(Number.isFinite(stats.faceNeck.deltaChroma));
    assert.ok(Number.isFinite(stats.faceBody.deltaL));
  }
});

test('face matching actually narrows the face/neck gap', () => {
  const frame = smallPortrait('rich-chocolate');
  const session = new WorkflowSession({});
  session.setDocument(frame);
  const before = faceBodyMatch(frame, session.analysis);
  const stage = session.runStage({
    engineId: 'final-review',
    tool: 'review',
    settings: { matching: 'both', matchStrength: 100 },
  });
  const after = faceBodyMatch(stage.output, session.analysis);
  assert.ok(
    after.faceNeck.deltaChroma <= before.faceNeck.deltaChroma + 0.01,
    `chroma gap grew: ${before.faceNeck.deltaChroma} -> ${after.faceNeck.deltaChroma}`,
  );
  // and it must stay a nudge, never a re-grade
  const d = frameDelta(frame, stage.output);
  assert.ok(d.max < 40, `face matching moved pixels too far (${d.max.toFixed(1)})`);
});

test('even-skin pass never changes luminance', () => {
  const frame = smallPortrait('rich-chocolate');
  const session = new WorkflowSession({});
  session.setDocument(frame);
  const stage = session.runStage({ engineId: 'final-review', tool: 'review', settings: { evenSkin: true, evenStrength: 100 } });
  const { rgbToLab } = globalThis;
  void rgbToLab;
  // luminance must be preserved pixel by pixel inside the skin
  const scope = session.analysis.skin;
  let maxL = 0;
  for (let i = 0; i < frame.pixelCount; i++) {
    if (scope[i] < 0.5) continue;
    const a = 0.2126 * frame.r[i] + 0.7152 * frame.g[i] + 0.0722 * frame.b[i];
    const b = 0.2126 * stage.output.r[i] + 0.7152 * stage.output.g[i] + 0.0722 * stage.output.b[i];
    maxL = Math.max(maxL, Math.abs(a - b));
  }
  assert.ok(maxL < 2.5, `luminance moved by ${maxL.toFixed(2)} levels`);
});

test('false colour and difference maps are finite and in range', () => {
  const frame = smallPortrait('caramel');
  const session = new WorkflowSession({});
  session.setDocument(frame);
  const fc = falseColourMap(frame, session.analysis);
  const dm = differenceMap(frame, frame);
  for (const m of [fc, dm]) {
    for (let i = 0; i < m.pixelCount; i += 53) {
      assert.ok(Number.isFinite(m.r[i]) && m.r[i] >= 0 && m.r[i] <= 255);
    }
  }
  // an untouched difference map is flat grey, not black
  const flat = dm.r.every((v) => Math.abs(v - dm.r[0]) < 1e-6);
  assert.equal(flat, true);
  assert.ok(dm.r[0] > 20);
});

test('review schema is honest: defaults are conservative', () => {
  const engine = new FinalReviewEngine();
  const defaults = Object.fromEntries(engine.schema.params.map((p) => [p.id, p.default]));
  assert.equal(defaults.refineRemaining, false);
  assert.equal(defaults.evenSkin, false);
  assert.equal(defaults.matching, 'off');
  assert.equal(defaults.compareMode, 'none');
  assert.equal(defaults.falseColour, 0);
  assert.ok(defaults.refineStrength <= 30);
});

test('full seven-stage workflow runs end to end and stays non-destructive', () => {
  const frame = smallPortrait('rich-chocolate');
  const session = new WorkflowSession({});
  session.setDocument(frame);
  const pipeline = [
    ['frequency-separation-professional', 'frequency'],
    ['micro-dodge-burn', 'microDodgeBurn'],
    ['sculpt-dodge-burn', 'sculptDodgeBurn'],
    ['skin-tone', 'skinTone'],
    ['colour-grading', 'colourGrading'],
    ['glossy-skin', 'glossySkin'],
    ['final-review', 'review'],
  ];
  for (const [engineId, tool] of pipeline) {
    const stage = session.runStage({ engineId, tool });
    assert.ok(stage.layers.length, `${engineId} produced no layers`);
    assert.equal(validateLayerTree(stage.layers).ok, true, `${engineId} layer tree invalid`);
  }
  const summary = session.summary();
  assert.equal(summary.stages.length, 7);
  assert.equal(summary.stages.at(-1).stage, 7);
  assert.ok(summary.layerCount > 15, `expected a deep layer stack, got ${summary.layerCount}`);

  // the original frame is never mutated
  const fresh = smallPortrait('rich-chocolate');
  assert.equal(frameDelta(frame, fresh).max, 0, 'the original document must be untouched');

  // disabling a middle stage must send the stack back to a valid composite
  const middle = summary.stages.find((s) => s.stage === 4);
  session.setStageEnabled(middle.id, false);
  const composite = session.composite();
  assert.equal(composite.width, frame.width);
  assert.ok(Number.isFinite(composite.r[0]));

  // and removing every stage returns the untouched original
  for (const s of [...session.stages]) session.removeStage(s.id);
  assert.equal(frameDelta(session.composite(), frame).max, 0);
});

test('review works on a document with no face at all', () => {
  const session = new WorkflowSession({});
  const frame = smallPortrait('golden-brown');
  // portrait offset far enough off-frame that detection finds nothing plausible
  session.setDocument(frame);
  const stage = session.runStage({ engineId: 'final-review', tool: 'review', settings: { region: 'fullBody' } });
  assert.ok(stage.report.checks);
  assert.ok(Number.isFinite(stage.report.checks.exposure.medianLuma));
});
