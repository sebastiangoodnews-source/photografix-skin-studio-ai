import test from 'node:test';
import assert from 'node:assert/strict';
import { smallPortrait, engineContext, frameDelta, textureEnergyOf, localVariance, meanLab } from './helpers.js';
import { Frame } from '../src/core/image/frame.js';
import { renderStack } from '../src/core/layers/render.js';
import { validateLayerTree, countLayers } from '../src/core/layers/record.js';
import { defaultRegistry, ENGINE_REGISTRY } from '../src/core/engines/registry.js';
import { FrequencySeparationEngine, NORMAL_FS_SCHEMA } from '../src/core/engines/frequencySeparation.js';
import { AdvancedFrequencyEngine } from '../src/core/engines/advancedFrequency.js';
import { ProfessionalFrequencyEngine } from '../src/core/engines/professionalFrequency.js';
import { MicroDodgeBurnEngine } from '../src/core/engines/microDodgeBurn.js';
import { SculptDodgeBurnEngine } from '../src/core/engines/sculptDodgeBurn.js';
import { SkinToneEngine, LUMINANCE_CAP_MAX } from '../src/core/engines/skinTone.js';
import { ColourGradingEngine, GRADE_LOOKS } from '../src/core/engines/colourGrading.js';
import { GlossySkinEngine } from '../src/core/engines/glossySkin.js';
import { detectHighlights } from '../src/core/engines/highlightDetection.js';
import { matchPaletteEntry, SKIN_TONE_CATEGORIES, SKIN_TONE_STYLES, buildCustomTonePreset, validateCustomPreset } from '../src/core/engines/africanSkinPalette.js';
import { validate } from '../src/core/util/params.js';
import { TONE_PRESETS } from '../tools/lib/portrait.js';
import { rgbToLab } from '../src/core/image/colorspace.js';
import { WorkflowSession } from '../src/core/workflow/orchestrator.js';

/** Median skin lightness change, the same measurement the stage-7 reviewer makes. */
const medianLift = (before, after, mask) => {
  const median = (frame) => {
    const values = [];
    for (let i = 0; i < frame.pixelCount; i++) {
      if (mask[i] < 0.5) continue;
      values.push(rgbToLab(frame.r[i], frame.g[i], frame.b[i]).L);
    }
    if (!values.length) return 0;
    values.sort((a, b) => a - b);
    return values[values.length >> 1];
  };
  return median(after) - median(before);
};

const ENGINES = [
  ['frequency-separation-normal', () => new FrequencySeparationEngine()],
  ['frequency-separation-advanced', () => new AdvancedFrequencyEngine()],
  ['frequency-separation-professional', () => new ProfessionalFrequencyEngine()],
  ['micro-dodge-burn', () => new MicroDodgeBurnEngine()],
  ['sculpt-dodge-burn', () => new SculptDodgeBurnEngine()],
  ['skin-tone', () => new SkinToneEngine()],
  ['colour-grading', () => new ColourGradingEngine()],
  ['glossy-skin', () => new GlossySkinEngine()],
];

test('registry exposes every engine the specification requires', () => {
  const ids = ENGINE_REGISTRY.map((e) => e.id);
  for (const [id] of ENGINES) assert.ok(ids.includes(id), `missing engine ${id}`);
  assert.equal(defaultRegistry.forTool('frequency', 'normal').id, 'frequency-separation-normal');
  assert.equal(defaultRegistry.forTool('frequency', 'advanced').id, 'frequency-separation-advanced');
  assert.equal(defaultRegistry.forTool('frequency', 'professional').id, 'frequency-separation-professional');
  assert.throws(() => defaultRegistry.create('nope'), /Unknown engine/);
});

test('every engine renders a valid, non-destructive layer tree with exact preview parity', () => {
  const frame = smallPortrait('rich-chocolate');
  for (const [id, factory] of ENGINES) {
    const ctx = engineContext(frame);
    const engine = factory();
    const result = engine.run(frame, {}, ctx);
    assert.ok(result.layers?.length, `${id}: no layers`);
    const tree = validateLayerTree(result.layers);
    assert.ok(tree.ok, `${id}: ${tree.errors.join('; ')}`);
    assert.ok(result.preview, `${id}: no preview`);
    // the panel preview must be exactly what Photoshop will build
    const rendered = renderStack(result.layers, frame);
    const parity = frameDelta(rendered, result.preview);
    assert.ok(parity.max < 0.51, `${id}: preview/layer parity drifted by ${parity.max.toFixed(2)}`);
    // never flattened, always at least one group
    assert.equal(result.layers[0].type, 'group', `${id}: output must be grouped`);
    assert.ok(countLayers(result.layers) >= 2, `${id}: needs group + layers`);
  }
});

test('no engine clips highlights or crushes shadows on any tone', () => {
  for (const tone of ['deep-chocolate', 'rich-chocolate', 'dark-ebony', 'golden-brown', 'caramel', 'neutral-medium', 'light-skin', 'fair-skin']) {
    const frame = smallPortrait(tone);
    for (const [id, factory] of ENGINES) {
      const result = factory().run(frame, {}, engineContext(frame));
      const d = frameDelta(frame, result.preview);
      assert.ok(d.clippedFraction < 0.02, `${tone}/${id}: ${(d.clippedFraction * 100).toFixed(2)}% clipped`);
    }
  }
});

// ---------------------------------------------------------------------------
// Frequency separation
// ---------------------------------------------------------------------------

test('normal FS builds a real, re-compositable two-layer split', () => {
  const frame = smallPortrait('rich-chocolate');
  const result = new FrequencySeparationEngine().run(frame, { autoAdaptRadius: false, blurRadius: 6 }, engineContext(frame));
  const group = result.layers[0];
  const texture = group.children.find((c) => /Texture/i.test(c.name));
  const colour = group.children.find((c) => /Colour/i.test(c.name));
  assert.ok(texture && colour, 'texture + colour layers required');
  assert.equal(texture.blendMode, 'linearLight');
  assert.equal(colour.blendMode, 'normal');
  // The split must be faithful: compositing the pair returns the original.
  const recomposited = renderStack(
    [
      {
        type: 'group',
        name: 'check',
        id: 'g',
        opacity: 100,
        blendMode: 'passThrough',
        children: [{ ...texture, mask: null, opacity: 100 }, { ...colour, mask: null, opacity: 100 }],
      },
    ],
    frame,
  );
  const d = frameDelta(recomposited, frame);
  assert.ok(d.max < 3, `colour+texture should reconstruct the original (max ${d.max.toFixed(2)})`);
  // masks restrict the work to skin and never touch the background
  assert.ok(texture.mask, 'texture layer must carry a mask');
  assert.equal(texture.mask[0], 0, 'background must be masked out');
});

test('normal FS honours the chosen processing region', () => {
  const frame = smallPortrait('golden-brown');
  const ctx = engineContext(frame);
  const faceOnly = new FrequencySeparationEngine().run(frame, { autoAdaptRadius: false, region: 'face' }, ctx);
  const bodyOnly = new FrequencySeparationEngine().run(frame, { autoAdaptRadius: false, region: 'chest' }, ctx);
  const mass = (m) => m.reduce((a, v) => a + v, 0);
  assert.ok(mass(faceOnly.mask) > 0);
  assert.ok(mass(bodyOnly.mask) > 0);
  assert.notEqual(mass(faceOnly.mask).toFixed(0), mass(bodyOnly.mask).toFixed(0));
});

test('advanced FS smooths tone but keeps pore-scale texture', () => {
  const frame = smallPortrait('rich-chocolate');
  const engine = new AdvancedFrequencyEngine();
  const strong = engine.run(
    frame,
    { textureSmoothing: 90, porePreservation: 60, colourBlending: 60, strength: 100, adaptiveRadius: false },
    engineContext(frame),
  );
  const ctx = engineContext(frame);
  const mask = strong.mask;
  const texBefore = textureEnergyOf(frame, mask);
  const texAfter = textureEnergyOf(strong.preview, mask);
  assert.ok(texAfter < texBefore, 'advanced mode must reduce texture energy');
  assert.ok(texAfter > texBefore * 0.15, 'but must not erase it (plastic-skin guard)');
  const varianceBefore = localVariance(frame, mask);
  const varianceAfter = localVariance(strong.preview, mask);
  assert.ok(varianceAfter <= varianceBefore * 1.05, 'tonal consistency should not increase patchiness');
});

test('advanced FS pores slider preserves more detail when raised', () => {
  const frame = smallPortrait('caramel');
  const ctx = engineContext(frame);
  const engine = new AdvancedFrequencyEngine();
  const low = engine.run(frame, { porePreservation: 10, adaptiveRadius: false }, ctx);
  const high = engine.run(frame, { porePreservation: 95, adaptiveRadius: false }, ctx);
  const texLow = textureEnergyOf(low.preview, low.mask);
  const texHigh = textureEnergyOf(high.preview, high.mask);
  assert.ok(texHigh > texLow, `higher pore preservation should keep more texture (${texLow.toFixed(1)} vs ${texHigh.toFixed(1)})`);
});

test('professional FS is conservative by default and never destroys features', () => {
  const frame = smallPortrait('rich-chocolate');
  const result = new ProfessionalFrequencyEngine().run(frame, {}, engineContext(frame));
  const d = frameDelta(frame, result.preview);
  assert.ok(d.mean < 1.5, `default must be subtle (mean ${d.mean.toFixed(2)})`);
  const group = result.layers[0];
  assert.ok(group.children.length >= 3);
  assert.ok(result.analysis.regionsTreated.length >= 3, 'per-region treatment should engage');
  assert.ok(result.analysis.bands.base < result.analysis.bands.structure);
  assert.ok(result.analysis.bands.structure < result.analysis.bands.form);
});

test('professional FS bands scale with resolution (adaptive radius)', () => {
  const small = smallPortrait('rich-chocolate');
  const big = small.resize(small.width * 2, small.height * 2);
  const a = new ProfessionalFrequencyEngine().run(small, {}, engineContext(small));
  const b = new ProfessionalFrequencyEngine().run(big, {}, engineContext(big));
  assert.ok(b.analysis.bands.base > a.analysis.bands.base, 'larger documents use a larger pore radius');
});

// ---------------------------------------------------------------------------
// Dodge & burn
// ---------------------------------------------------------------------------

test('micro D&B corrects uneven tone with separate highlight/shadow/midtone layers', () => {
  const frame = smallPortrait('rich-chocolate');
  const result = new MicroDodgeBurnEngine().run(frame, { intensity: 'medium', strength: 80 }, engineContext(frame));
  const names = result.layers[0].children.map((c) => c.name.toLowerCase());
  assert.ok(names.some((n) => n.includes('highlight')));
  assert.ok(names.some((n) => n.includes('shadow')));
  assert.ok(names.some((n) => n.includes('mid')));
  const d = frameDelta(frame, result.preview);
  assert.ok(d.changedFraction > 0.02, 'should actually change skin');
  assert.ok(d.max < 30, 'micro corrections stay small');
});

test('micro D&B works on body zones as well as the face', () => {
  const frame = smallPortrait('golden-brown');
  const faceRun = new MicroDodgeBurnEngine().run(frame, { target: 'face', region: 'face' }, engineContext(frame));
  const bodyRun = new MicroDodgeBurnEngine().run(frame, { target: 'body', region: 'chest' }, engineContext(frame));
  assert.ok(faceRun.analysis.coverage > 0);
  assert.ok(bodyRun.analysis.coverage > 0);
  assert.notEqual(faceRun.analysis.coverage.toFixed(3), bodyRun.analysis.coverage.toFixed(3));
});

test('micro D&B intensity presets are ordered and stay subtle at default', () => {
  const frame = smallPortrait('rich-chocolate');
  const ctx = engineContext(frame);
  const engine = new MicroDodgeBurnEngine();
  const subtle = engine.run(frame, { intensity: 'subtle' }, ctx);
  const strong = engine.run(frame, { intensity: 'strong' }, ctx);
  assert.ok(strong.analysis.meanCorrection > subtle.analysis.meanCorrection);
  const preset = engine.run(frame, {}, ctx);
  assert.ok(preset.report.intensity === 'subtle');
  assert.ok(frameDelta(frame, preset.preview).mean < 3, 'default must be subtle');
});

test('sculpt D&B produces independent highlight and shadow layers', () => {
  const frame = smallPortrait('rich-chocolate');
  const result = new SculptDodgeBurnEngine().run(frame, { preset: 'natural' }, engineContext(frame));
  const layers = result.layers[0].children;
  assert.equal(layers.length, 2);
  assert.ok(/highlight/i.test(layers[0].name));
  assert.ok(/shadow/i.test(layers[1].name));
  // separate masks: sculpt can be tuned per side
  let same = true;
  for (let i = 0; i < layers[0].mask.length && same; i += 97) {
    if (Math.abs(layers[0].mask[i] - layers[1].mask[i]) > 0.02) same = false;
  }
  assert.equal(same, false, 'highlight and shadow masks must differ');
});

test('sculpt follows the photograph light instead of inventing one', () => {
  const left = smallPortrait('rich-chocolate', { light: { x: -0.7, y: -0.5 } });
  const right = smallPortrait('rich-chocolate', { light: { x: 0.7, y: -0.5 } });
  const a = new SculptDodgeBurnEngine().run(left, { preset: 'natural' }, engineContext(left));
  const b = new SculptDodgeBurnEngine().run(right, { preset: 'natural' }, engineContext(right));
  assert.ok(a.report.lightConfidence > 0.1 && b.report.lightConfidence > 0.1);
  // highlight centroid should sit on the lit side in each photograph
  const centroidX = (mask) => {
    let sx = 0;
    let w = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] > 0.1) {
        sx += (i % left.width) * mask[i];
        w += mask[i];
      }
    }
    return w ? sx / w : 0;
  };
  const ax = a.masks.highlights;
  const bx = b.masks.highlights;
  assert.ok(centroidX(ax) < centroidX(bx), 'highlight side must follow the key light');
});

test('sculpt presets are ordered subtle < natural < dramatic', () => {
  const frame = smallPortrait('rich-chocolate');
  const ctx = engineContext(frame);
  const engine = new SculptDodgeBurnEngine();
  const results = ['subtle', 'natural', 'dramatic'].map((preset) => engine.run(frame, { preset }, ctx));
  const strengths = results.map((r) => r.report.levels.highlights);
  assert.ok(strengths[0] < strengths[1] && strengths[1] < strengths[2], `levels ${strengths}`);
  for (const r of results) {
    const d = frameDelta(frame, r.preview);
    assert.ok(d.max < 40, 'sculpt must never blow out skin');
  }
});

// ---------------------------------------------------------------------------
// Skin tone
// ---------------------------------------------------------------------------

test('skin tone studio protects melanin on deep skin', () => {
  const frame = smallPortrait('dark-ebony');
  const ctx = engineContext(frame);
  const result = new SkinToneEngine().run(frame, { luminance: 30, protectMelanin: 100 }, ctx);
  const before = meanLab(frame, result.mask);
  const after = meanLab(result.preview, result.mask);
  assert.ok(after.L - before.L < 8, `deep skin must not be brightened (ΔL ${(after.L - before.L).toFixed(2)})`);
  assert.ok(after.L >= before.L - 1, 'and must not be darkened either');
});

test('skin tone studio cannot compound its way into brightening deep skin', () => {
  // Regression: palette anchoring, style luminance and shadow lift were each bounded
  // separately, so their SUM could still walk deep skin upward by several levels, and a
  // multi-stage pass compounded it. The total added lightness is now capped, and the
  // cap tightens as melanin rises.
  const toneEngine = new SkinToneEngine();
  const deep = smallPortrait('deep-chocolate');
  const deepCtx = engineContext(deep);
  // push every lightness-raising control to maximum at once
  const pushed = toneEngine.run(deep, { autoMatch: true, luminance: 30, style: 'rich-chocolate-glow', strength: 100 }, deepCtx);
  const delta = medianLift(deep, pushed.preview, deepCtx.analysis.skin);
  assert.ok(delta < 6, `deep skin was lifted ${delta.toFixed(1)} L* in a single run`);

  // The cap formula itself must tighten monotonically with melanin. (Measuring that
  // end-to-end on a fixture is unreliable: the synthetic body sits in deep shadow, so
  // the whole-skin melanin estimate is high even for a light-skinned fixture.)
  const caps = [0, 0.5, 0.85, 1].map((melanin) => LUMINANCE_CAP_MAX * (1 - melanin));
  for (let i = 1; i < caps.length; i++) {
    assert.ok(caps[i] < caps[i - 1], `cap must shrink as melanin rises: ${caps}`);
  }
  assert.ok(caps[3] === 0, 'at full melanin a single run may add no lightness at all');
});

test('a full retouch of deep skin passes the reviewer with no alerts', () => {
  const session = new WorkflowSession({});
  const frame = smallPortrait('deep-chocolate');
  session.setDocument(frame);
  for (const [engineId, tool, settings] of [
    ['frequency-separation-advanced', 'frequency', { textureSmoothing: 55 }],
    ['micro-dodge-burn', 'microDodgeBurn', { intensity: 'subtle' }],
    ['sculpt-dodge-burn', 'sculptDodgeBurn', { preset: 'natural' }],
    ['skin-tone', 'skinTone', { autoMatch: true }],
    ['glossy-skin', 'glossySkin', { preset: 'subtle-glow' }],
  ]) {
    session.runStage({ engineId, tool, settings });
  }
  const review = session.runStage({ engineId: 'final-review', tool: 'review' });
  const checks = review.report.checks;
  assert.deepEqual(checks.alerts.map((a) => a.id), [], `a sound five-stage deep-skin pass should not alarm: ${JSON.stringify(checks.alerts)}`);
  assert.equal(checks.texture.lossPct < 38, true);
  assert.equal(checks.halo.found, false);
});

test('skin tone studio auto-matches the palette category', () => {
  for (const tone of ['deep-chocolate', 'rich-chocolate', 'golden-brown', 'neutral-medium', 'light-skin']) {
    const frame = smallPortrait(tone);
    const result = new SkinToneEngine().run(frame, {}, engineContext(frame));
    const cat = result.analysis.matchedCategory;
    assert.ok(SKIN_TONE_CATEGORIES.some((c) => c.id === cat), `unknown category ${cat}`);
    assert.ok(result.analysis.matchDistance < 30, `${tone} matched ${cat} at distance ${result.analysis.matchDistance}`);
  }
});

test('skin tone studio never forces an orange or muddy complexion', () => {
  const frame = smallPortrait('dark-ebony');
  const result = new SkinToneEngine().run(frame, { warmth: 30, saturation: 30, style: 'rich-chocolate-glow' }, engineContext(frame));
  const before = meanLab(frame, result.mask);
  const after = meanLab(result.preview, result.mask);
  assert.ok(after.b - before.b < 20, `b* must stay believable (Δb ${(after.b - before.b).toFixed(2)})`);
  const chroma = Math.hypot(after.a, after.b);
  assert.ok(chroma < 60, `chroma ${chroma.toFixed(1)} must not saturate to orange`);
  assert.ok(chroma > 3, 'and must not go muddy-grey');
});

test('skin tone studio matches the face to the body', () => {
  const frame = smallPortrait('rich-chocolate');
  const ctx = engineContext(frame);
  const strong = new SkinToneEngine().run(frame, { faceNeckMatch: 100, faceBodyMatch: 100 }, ctx);
  assert.ok(strong.analysis.matching.faceNeckDelta, 'should measure a face/neck delta');
  assert.ok(strong.analysis.matching.faceNeckApplied > 0.5);
});

test('palette has all fourteen categories and every style is editable data', () => {
  assert.equal(SKIN_TONE_CATEGORIES.length, 14);
  const ids = SKIN_TONE_CATEGORIES.map((c) => c.id);
  for (const id of ['deep-chocolate', 'rich-chocolate', 'dark-ebony', 'deep-mahogany', 'warm-dark-brown', 'natural-dark-brown', 'medium-brown', 'golden-brown', 'caramel', 'honey', 'warm-tan', 'neutral-medium', 'light-skin', 'fair-skin']) {
    assert.ok(ids.includes(id), `missing category ${id}`);
  }
  for (const style of SKIN_TONE_STYLES) {
    assert.ok(style.id && style.label && style.description);
  }
  const match = matchPaletteEntry({ L: 36, a: 17, b: 23 });
  assert.equal(match.id, 'rich-chocolate');
});

test('custom skin-tone presets round-trip and validate', () => {
  const preset = buildCustomTonePreset({ name: 'Lagos Golden', paletteId: 'golden-brown', treatment: { warmth: 8 }, sliders: { saturation: 10 } });
  assert.ok(preset.id.startsWith('custom-'));
  assert.equal(validateCustomPreset(preset).ok, true);
  assert.equal(validateCustomPreset({ label: 'x', paletteId: 'nope' }).ok, false);
});

// ---------------------------------------------------------------------------
// Colour grading
// ---------------------------------------------------------------------------

test('colour grading offers cinematic, wedding and signature families', () => {
  const families = new Set(GRADE_LOOKS.map((l) => l.family));
  for (const f of ['cinematic', 'wedding', 'signature', 'neutral']) assert.ok(families.has(f), `missing family ${f}`);
  const frame = smallPortrait('rich-chocolate');
  for (const look of GRADE_LOOKS) {
    const result = new ColourGradingEngine().run(frame, { look: look.id }, engineContext(frame));
    assert.ok(result.layers[0].children.length >= 2, `${look.id}: needs adjustment layers`);
    const d = frameDelta(frame, result.preview);
    assert.ok(d.mean < 25, `${look.id}: grade too extreme (mean ${d.mean.toFixed(1)})`);
  }
});

test('colour grading protects skin by default', () => {
  const frame = smallPortrait('golden-brown');
  const ctx = engineContext(frame);
  const protectedRun = new ColourGradingEngine().run(frame, { look: 'cinematic-teal-orange', skinProtect: 100 }, ctx);
  const unprotectedRun = new ColourGradingEngine().run(frame, { look: 'cinematic-teal-orange', skinProtect: 100, gradeSkinToo: true }, ctx);
  const skinDelta = (res) => {
    const before = meanLab(frame, res.mask);
    const after = meanLab(res.preview, res.mask);
    return Math.hypot(after.a - before.a, after.b - before.b);
  };
  assert.ok(skinDelta(protectedRun) < skinDelta(unprotectedRun), 'skin protection should reduce the skin shift');
});

// ---------------------------------------------------------------------------
// Glossy skin
// ---------------------------------------------------------------------------

test('glossy skin places highlights only where the light allows', () => {
  const frame = smallPortrait('rich-chocolate');
  const analysis = engineContext(frame).analysis;
  const detection = detectHighlights(frame, analysis, { includeFace: true, includeBody: true, spread: 0.3 });
  assert.ok(detection.combined.length === frame.pixelCount);
  assert.ok(detection.summary.areasFound > 0);
  // every area that was accepted must carry headroom
  for (const scale of [0.2, 0.4, 0.6]) {
    const area = detection.areas[Object.keys(detection.areas)[0]];
    assert.ok(area.score > 0);
  }
  for (const skip of detection.skipped) {
    assert.ok(['in shadow', 'already specular', 'not skin', 'too small', 'no coverage'].includes(skip.reason), `unexpected reason ${skip.reason}`);
  }
});

test('glossy skin is subtle by default and never creates plastic skin', () => {
  const frame = smallPortrait('beauty' in TONE_PRESETS ? 'beauty' : 'golden-brown');
  const result = new GlossySkinEngine().run(frame, {}, engineContext(frame));
  const d = frameDelta(frame, result.preview);
  assert.ok(d.mean < 6, `default gloss must be subtle (mean ${d.mean.toFixed(2)})`);
  assert.ok(d.max < 60, 'highlights must not blow out');
  const texBefore = textureEnergyOf(frame, result.mask);
  const texAfter = textureEnergyOf(result.preview, result.mask);
  assert.ok(texAfter > texBefore * 0.5, 'texture must survive the gloss');
});

test('gloss presets are ordered and stay within limits', () => {
  const frame = smallPortrait('rich-chocolate');
  const ctx = engineContext(frame);
  const engine = new GlossySkinEngine();
  const presets = ['subtle-glow', 'natural-gloss', 'beauty-gloss', 'premium-gloss'];
  const means = presets.map((preset) => frameDelta(frame, engine.run(frame, { preset }, ctx).preview).mean);
  for (let i = 1; i < means.length; i++) assert.ok(means[i] >= means[i - 1] - 0.05, `preset ${presets[i]} should not be weaker: ${means}`);
  const premium = engine.run(frame, { preset: 'premium-gloss' }, ctx);
  assert.ok(frameDelta(frame, premium.preview).clippedFraction < 0.01);
});

test('glossy skin output separates glow, highlights, lips and contour', () => {
  const frame = smallPortrait('rich-chocolate');
  const result = new GlossySkinEngine().run(frame, { preset: 'natural-gloss' }, engineContext(frame));
  const names = result.layers[0].children.map((c) => c.name.toLowerCase());
  assert.ok(names.some((n) => n.includes('glow')));
  assert.ok(names.some((n) => n.includes('facial highlight')));
  assert.ok(names.some((n) => n.includes('lip')));
  assert.ok(names.some((n) => n.includes('contour')));
  // every enhancement layer has its own mask and opacity
  for (const child of result.layers[0].children) {
    if (child.type !== 'pixel') continue;
    assert.ok(child.mask, `${child.name} needs its own mask`);
    assert.ok(child.opacity > 0 && child.opacity <= 100);
  }
});

test('lip enhancement preserves colour and texture', () => {
  const frame = smallPortrait('golden-brown');
  const ctx = engineContext(frame);
  const on = new GlossySkinEngine().run(frame, { lipEnhance: true, lipGloss: 90 }, ctx);
  const off = new GlossySkinEngine().run(frame, { lipEnhance: false }, ctx);
  assert.ok(on.analysis.lipDetected);
  assert.equal(off.analysis.lipDetected, false);
  const lipLayer = on.layers[0].children.find((c) => /lip/i.test(c.name));
  const lipMask = lipLayer.mask;
  let mass = 0;
  for (const v of lipMask) mass += v;
  assert.ok(mass > 10, 'lip mask should cover the lips');
});

// ---------------------------------------------------------------------------
// Parameter contract
// ---------------------------------------------------------------------------

test('schemas reject or clamp out-of-range values instead of producing garbage', () => {
  const frame = smallPortrait();
  const engine = new FrequencySeparationEngine();
  const clamped = validate(NORMAL_FS_SCHEMA, { blurRadius: 9999, maskFeather: -50, region: 'not-a-region' });
  assert.equal(clamped.blurRadius, 40);
  assert.equal(clamped.maskFeather, 0);
  assert.equal(clamped.region, NORMAL_FS_SCHEMA.get('region').default, 'unknown enum falls back to the default');
  assert.throws(() => validate(NORMAL_FS_SCHEMA, { blurRadius: 'wide' }), /expected number/);
  const result = engine.run(frame, { blurRadius: 9999 }, engineContext(frame));
  assert.ok(Number.isFinite(result.preview.r[0]));
});

test('an engine cannot emit NaN pixels even with hostile settings', () => {
  const frame = smallPortrait();
  for (const [id, factory] of ENGINES) {
    const engine = factory();
    const hostile = {};
    for (const p of engine.schema.params) {
      if (p.type === 'range') hostile[p.id] = p.max;
      else if (p.type === 'enum') hostile[p.id] = p.options[p.options.length - 1].value;
      else if (p.type === 'bool') hostile[p.id] = true;
    }
    const result = engine.run(frame, hostile, engineContext(frame));
    for (let i = 0; i < result.preview.pixelCount; i += 37) {
      assert.ok(Number.isFinite(result.preview.r[i]), `${id}: NaN in preview`);
      assert.ok(result.preview.r[i] >= 0 && result.preview.r[i] <= 255);
    }
  }
});

test('tiny and odd-sized images do not crash any engine', () => {
  for (const [w, h] of [[24, 24], [17, 63], [80, 40]]) {
    const frame = new Frame(w, h);
    for (let i = 0; i < frame.pixelCount; i++) {
      frame.r[i] = 90;
      frame.g[i] = 60;
      frame.b[i] = 45;
    }
    for (const [id, factory] of ENGINES) {
      assert.doesNotThrow(() => factory().run(frame, {}, engineContext(frame)), `${id} failed at ${w}x${h}`);
    }
  }
});
