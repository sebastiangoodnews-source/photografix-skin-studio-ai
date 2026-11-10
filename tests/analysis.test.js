import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortrait, TONE_PRESETS } from '../tools/lib/portrait.js';
import { skinProbability, skinMask, summariseSkin, melaninIndex, classifyUndertone, skinProbabilityField } from '../src/core/analysis/skin.js';
import { analyseExposure, estimateLightDirection, computeHistogram, percentileFromHistogram, estimateSharpness } from '../src/core/analysis/histogram.js';
import { connectedComponents, regionMoments, headFromSilhouette, featherMask } from '../src/core/analysis/regions.js';
import { detectFace, faceLandmarks, faceRegionMasks, analyseFaceSurface } from '../src/core/segmentation/face.js';
import { detectBody, BODY_ZONES } from '../src/core/segmentation/body.js';
import { RegionResolver, REGION_IDS } from '../src/core/regions/zones.js';

const TONES = ['deep-chocolate', 'rich-chocolate', 'dark-ebony', 'golden-brown', 'caramel', 'neutral-medium', 'light-skin', 'fair-skin'];

test('skin detection works across the full melanin range', () => {
  for (const tone of TONES) {
    const preset = TONE_PRESETS[tone];
    const [r, g, b] = preset.rgb;
    const p = skinProbability(r, g, b);
    assert.ok(p > 0.55, `${tone} (${r},${g},${b}) should read as skin, got ${p.toFixed(2)}`);
  }
});

test('skin detection rejects background, clothing and neutral surfaces', () => {
  const nonSkin = [
    [22, 24, 32],
    [255, 255, 255],
    [0, 0, 0],
    [128, 128, 128],
    [40, 60, 120],
    [30, 110, 40],
  ];
  for (const [r, g, b] of nonSkin) {
    const p = skinProbability(r, g, b);
    assert.ok(p < 0.5, `(${r},${g},${b}) should not read as skin, got ${p.toFixed(2)}`);
  }
});

test('deep skin is not penalised for being dark', () => {
  const ebony = skinProbability(...TONE_PRESETS['dark-ebony'].rgb);
  const fair = skinProbability(...TONE_PRESETS['fair-skin'].rgb);
  assert.ok(ebony > 0.6 && fair > 0.6, `ebony ${ebony.toFixed(2)} fair ${fair.toFixed(2)}`);
  assert.ok(Math.abs(ebony - fair) < 0.45, 'detector must be luminance-neutral');
});

test('deep-skin shadow keeps one continuous mask (no shadow-line cut)', () => {
  // Regression: the b* axis collapses in underexposed deep skin, so a hue-angle test
  // dropped the shadowed half of the torso and the mask stopped at the shadow line.
  // That showed up as a diagonal band in the composite.
  const frame = createPortrait({ width: 420, height: 560, tone: 'deep-chocolate' });
  const mask = skinMask(frame, {});
  const width = frame.width;
  // Walk down the shadowed side of the torso. The first rows are still background;
  // the assertion is that once the subject starts, the mask does not let go of it
  // (the original bug produced a hard stop at the shadow boundary).
  const x = Math.round(width * 0.78);
  let started = false;
  let misses = 0;
  let rows = 0;
  for (let y = 330; y < 520; y += 3) {
    const i = y * width + x;
    const onSubject = frame.r[i] >= 12 && frame.g[i] <= frame.r[i];
    if (!onSubject) {
      if (started) misses += 2; // leaving the subject again is a cut
      continue;
    }
    started = true;
    rows++;
    if (mask[i] <= 0.5) misses++;
  }
  assert.ok(rows > 20, `expected the torso to span the probe, got ${rows} rows`);
  assert.equal(misses, 0, `the mask cut the shadowed torso in ${misses} places`);
});

test('deep shadow is still not confused with background or clothing', () => {
  // the shadow branch must not become a "everything dark is skin" rule
  for (const [r, g, b] of [[22, 24, 32], [10, 12, 26], [8, 8, 9], [18, 30, 22], [26, 20, 28], [40, 20, 45], [12, 14, 22]]) {
    assert.ok(skinProbability(r, g, b) < 0.4, `(${r},${g},${b}) read as skin at ${skinProbability(r, g, b).toFixed(2)}`);
  }
  // and it must stay on the warm red axis
  assert.ok(skinProbability(37, 0, 0) > 0.8, 'a shadowed deep-skin sample should read as skin');
});

test('melanin index and undertone classification are ordered', () => {
  const ebony = melaninIndex(22, 15);
  const fair = melaninIndex(84, 18);
  assert.ok(ebony > fair, `ebony ${ebony} > fair ${fair}`);
  assert.ok(ebony > 0.6 && fair < 0.3);
  assert.equal(classifyUndertone({ L: 40, a: 18, b: 10 }), 'red');
  assert.equal(classifyUndertone({ L: 60, a: 12, b: 20 }), 'orange');
  assert.equal(classifyUndertone({ L: 70, a: 6, b: 26 }), 'olive');
});

test('skin mask + statistics describe a portrait', () => {
  const frame = createPortrait({ width: 180, height: 240, tone: 'rich-chocolate' });
  const mask = skinMask(frame, {});
  let covered = 0;
  for (const v of mask) if (v > 0.5) covered++;
  const coverage = covered / mask.length;
  assert.ok(coverage > 0.15 && coverage < 0.75, `coverage ${coverage}`);
  const stats = summariseSkin(frame, mask);
  assert.ok(stats.melanin > 0.4, 'rich chocolate should read as high melanin');
  // The fixture's body falls into deep shadow, so the whole-skin median sits low;
  // the face is the meaningful reference for "does this look like the tone".
  const faceStats = summariseSkin(frame, skinMask(frame, { low: 0.5, high: 0.8 }));
  assert.ok(stats.lab.L > 5 && stats.lab.L < 60, `skin L ${stats.lab.L}`);
  assert.ok(faceStats.lab.L > stats.lab.L - 2, 'lit regions are not darker than the average');
  assert.ok(['red', 'red-orange', 'orange', 'golden'].includes(stats.undertone));
});

test('probability field is smooth (no per-pixel speckle)', () => {
  const frame = createPortrait({ width: 120, height: 160 });
  const field = skinProbabilityField(frame, {});
  let jumps = 0;
  for (let i = 1; i < field.length; i++) if (Math.abs(field[i] - field[i - 1]) > 0.5) jumps++;
  assert.ok(jumps < field.length * 0.01, `unexpectedly jumpy field: ${jumps}`);
});

test('exposure analysis reports sane statistics', () => {
  const frame = createPortrait({ width: 140, height: 180 });
  const a = analyseExposure(frame);
  assert.ok(a.medianLuma > 0 && a.medianLuma < 255);
  assert.ok(a.dynamicRange > 10);
  assert.ok(a.clippedHighlightsPct < 25);
  const hist = computeHistogram(frame);
  assert.equal(hist.reduce((x, y) => x + y, 0), frame.pixelCount);
  assert.ok(percentileFromHistogram(hist, 0) <= percentileFromHistogram(hist, 1));
  assert.ok(estimateSharpness(frame) >= 0);
});

test('light direction follows the actual key light (no contradictory lighting)', () => {
  for (const light of [
    { x: -0.6, y: -0.5 },
    { x: 0.6, y: -0.4 },
    { x: 0, y: -1 },
    { x: -0.5, y: 0.5 },
  ]) {
    const frame = createPortrait({ width: 200, height: 260, light });
    const est = estimateLightDirection(frame);
    const len = Math.hypot(light.x, light.y);
    const cos = (est.x * light.x + est.y * light.y) / len;
    assert.ok(cos > 0.5, `light ${JSON.stringify(light)} estimated as ${JSON.stringify(est)} (cos ${cos.toFixed(2)})`);
  }
});

test('connected components and moments recover a known blob', () => {
  const w = 20;
  const h = 20;
  const mask = new Float32Array(w * h);
  for (let y = 6; y < 12; y++) for (let x = 7; x < 13; x++) mask[y * w + x] = 1;
  const { labels, components } = connectedComponents(mask, w, h, 0.5, 4);
  assert.equal(components.length, 1);
  assert.equal(components[0].area, 36);
  const m = regionMoments(labels, components[0].label, w);
  assert.ok(Math.abs(m.cx - 9.5) < 0.6);
  assert.ok(Math.abs(m.cy - 8.5) < 0.6);
});

test('silhouette neck split finds the head in a full portrait', () => {
  const frame = createPortrait({ width: 160, height: 220 });
  const mask = skinMask(frame, {});
  const head = headFromSilhouette(mask, 160, 220, 0.45);
  assert.ok(head, 'head region should be found');
  assert.ok(head.aspect > 0.5 && head.aspect < 2.6);
  assert.ok(head.bbox.height < 220 * 0.75, 'head must not include the torso');
});

test('face detection returns a plausible ellipse and landmarks for every tone', () => {
  for (const tone of TONES) {
    const frame = createPortrait({ width: 160, height: 220, tone });
    const face = detectFace(frame);
    assert.ok(face.found, `${tone}: face not found`);
    assert.ok(face.confidence > 0.5, `${tone}: low confidence ${face.confidence}`);
    const e = face.ellipse;
    assert.ok(e.cx > 40 && e.cx < 120 && e.cy > 20 && e.cy < 140, `${tone}: bad centre ${JSON.stringify(e)}`);
    assert.ok(e.ry >= e.rx, `${tone}: face should be taller than wide`);
    const lm = faceLandmarks(frame, face);
    assert.ok(lm.interocular > 4);
    assert.ok(lm.points.leftEye.x < lm.points.rightEye.x, 'eye order');
    assert.ok(lm.points.chin.y > lm.points.forehead.y, 'chin below forehead');
  }
});

test('facial zone masks are non-empty, bounded and inside the face', () => {
  const frame = createPortrait({ width: 200, height: 260, tone: 'golden-brown' });
  const face = detectFace(frame);
  const zones = faceRegionMasks(frame, face, faceLandmarks(frame, face), {});
  for (const key of ['forehead', 'cheeks', 'nose', 'lips', 'chin', 'underEye', 'cheekbones', 'jawline']) {
    const z = zones[key];
    let mass = 0;
    for (const v of z) mass += v;
    assert.ok(mass > 20, `${key} mask is empty (mass ${mass})`);
    assert.ok(mass < frame.pixelCount * 0.7, `${key} mask covers too much`);
  }
  // lips should sit below the eyes and above the chin
  const centroid = (mask) => {
    let sy = 0;
    let n = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] > 0.5) {
        sy += Math.floor(i / frame.width);
        n++;
      }
    }
    return n ? sy / n : 0;
  };
  assert.ok(centroid(zones.lips) > centroid(zones.eyesSockets || zones.underEye));
  assert.ok(centroid(zones.lips) < centroid(zones.chin));
});

test('face surface analysis suggests a workable radius', () => {
  const frame = createPortrait({ width: 200, height: 260 });
  const face = detectFace(frame);
  const surface = analyseFaceSurface(frame, face);
  assert.ok(surface.suggestedRadius >= 4 && surface.suggestedRadius <= 24);
  assert.ok(surface.suggestedTextureRadius < surface.suggestedRadius);
  assert.ok(surface.textureNorm >= 0 && surface.textureNorm <= 1);
});

test('body segmentation finds anatomical zones for a portrait', () => {
  const frame = createPortrait({ width: 160, height: 220 });
  const face = detectFace(frame);
  const body = detectBody(frame, face);
  assert.ok(body.found);
  assert.ok(body.zonesPresent.length >= 3, `zones: ${body.zonesPresent}`);
  for (const zone of body.zonesPresent) assert.ok(BODY_ZONES.includes(zone) || zone === 'collarbone');
  assert.ok(body.anchors.faceHeight > 20);
  assert.ok(body.confidence > 0.5);
});

test('region resolver exposes every selectable region', () => {
  const frame = createPortrait({ width: 150, height: 200 });
  const resolver = new RegionResolver({});
  const analysis = resolver.analyse(frame);
  for (const region of REGION_IDS) {
    const mask = resolver.regionMask(analysis, region, {});
    assert.equal(mask.length, frame.pixelCount, `${region} mask length`);
    if (region === 'custom') {
      // custom without a supplied selection falls back to skin
      continue;
    }
  }
  const custom = resolver.regionMask(analysis, 'custom', { customRect: { x: 10, y: 10, width: 40, height: 40 } });
  let inner = 0;
  for (let y = 15; y < 45; y++) for (let x = 15; x < 45; x++) inner += custom[y * frame.width + x];
  assert.ok(inner > 100, 'custom rectangle selection should be filled');
});

test('feathering does not spill outside the mask (no halo on background)', () => {
  const w = 40;
  const h = 40;
  const mask = new Float32Array(w * h);
  for (let y = 12; y < 24; y++) for (let x = 12; x < 24; x++) mask[y * w + x] = 1;
  const feathered = featherMask(mask, w, h, 5);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) assert.equal(feathered[i], 0, `mask leaked at ${i}`);
  }
});
