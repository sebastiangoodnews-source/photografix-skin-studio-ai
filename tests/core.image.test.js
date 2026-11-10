import test from 'node:test';
import assert from 'node:assert/strict';
import { Frame } from '../src/core/image/frame.js';
import { blurFrame, blurChannelArray, radiusToSigma } from '../src/core/image/filters.js';
import { rgbToLab, labToRgb, rgbToLch, lchToRgb, rgbToHsl, hslToRgb } from '../src/core/image/colorspace.js';
import * as blend from '../src/core/image/blend.js';
import { erode, dilate, medianFilter, guidedFilter, boxMean, softThreshold } from '../src/core/image/morphology.js';
import { clamp, percentile, gaussianKernel1D, makeRng } from '../src/core/util/math.js';

test('Frame constructs planar channels and validates input', () => {
  const f = new Frame(4, 3);
  assert.equal(f.pixelCount, 12);
  assert.equal(f.channels.length, 3);
  assert.equal(f.channels[0].length, 12);
  assert.throws(() => new Frame(0, 4), /invalid dimensions/);
  assert.throws(() => new Frame(4, 4, [new Float32Array(3)]), /length mismatch/);
});

test('Frame round-trips RGBA without drift', () => {
  const rgba = new Uint8ClampedArray(4 * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) % 256;
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const f = Frame.fromRGBA(2, 2, rgba);
  const out = f.toRGBA();
  for (let i = 0; i < rgba.length; i++) assert.equal(out[i], rgba[i]);
});

test('Frame.clone is deep and independent', () => {
  const f = new Frame(2, 2);
  f.r[0] = 42;
  const c = f.clone();
  c.r[0] = 9;
  assert.equal(f.r[0], 42);
  assert.equal(c.r[0], 9);
});

test('Frame.resize preserves a flat colour exactly', () => {
  const f = new Frame(10, 10);
  f.r.fill(120);
  f.g.fill(80);
  f.b.fill(60);
  const small = f.resize(5, 5);
  assert.equal(small.r[0], 120);
  assert.equal(small.width, 5);
  const big = f.resize(20, 20);
  assert.ok(Math.abs(big.r[0] - 120) < 1e-3);
});

test('gaussian blur preserves the mean of a flat field and reduces variance', () => {
  const f = new Frame(32, 32);
  for (let i = 0; i < f.pixelCount; i++) f.r[i] = i % 2 ? 200 : 20;
  const blurred = blurFrame(f, 4);
  const meanBefore = f.r.reduce((a, v) => a + v, 0) / f.pixelCount;
  const meanAfter = blurred.r.reduce((a, v) => a + v, 0) / blurred.pixelCount;
  assert.ok(Math.abs(meanBefore - meanAfter) < 3);
  const varAfter = variance(blurred.r);
  const varBefore = variance(f.r);
  assert.ok(varAfter < varBefore * 0.5, `blur should smooth (${varBefore} -> ${varAfter})`);
});

test('blur radius 0 is a no-op and sigma scales with radius', () => {
  const f = new Frame(8, 8);
  f.r.fill(77);
  const same = blurFrame(f, 0);
  assert.equal(same.r[3], 77);
  assert.ok(radiusToSigma(10) > radiusToSigma(2));
});

test('Lab conversion round-trips within 1 level', () => {
  for (const rgb of [
    [255, 255, 255],
    [0, 0, 0],
    [120, 70, 45],
    [30, 18, 12],
    [200, 170, 150],
  ]) {
    const lab = rgbToLab(...rgb);
    const back = labToRgb(lab.L, lab.a, lab.b);
    assert.ok(Math.abs(back.r - rgb[0]) < 1.2, `r ${rgb} -> ${back.r}`);
    assert.ok(Math.abs(back.g - rgb[1]) < 1.2, `g ${rgb} -> ${back.g}`);
    assert.ok(Math.abs(back.b - rgb[2]) < 1.2, `b ${rgb} -> ${back.b}`);
  }
});

test('deep skin keeps its hue through Lab round-trip (melanin safety)', () => {
  const lab = rgbToLab(58, 32, 20);
  const back = labToRgb(lab.L, lab.a, lab.b);
  const lab2 = rgbToLab(back.r, back.g, back.b);
  assert.ok(Math.abs(lab.L - lab2.L) < 0.5);
  assert.ok(Math.abs(lab.a - lab2.a) < 0.6);
  assert.ok(Math.abs(lab.b - lab2.b) < 0.6);
});

test('LCh and HSL conversions round-trip', () => {
  const lch = rgbToLch(140, 90, 60);
  const rgb = lchToRgb(lch.L, lch.C, lch.H);
  assert.ok(Math.abs(rgb.r - 140) < 2);
  const hsl = rgbToHsl(200, 100, 50);
  const rgb2 = hslToRgb(hsl.h, hsl.s, hsl.l);
  assert.ok(Math.abs(rgb2.r - 200) < 1.5);
});

test('blend modes behave per Photoshop semantics', () => {
  assert.equal(blend.normal(10, 200), 200);
  assert.equal(blend.multiply(255, 128), 128);
  assert.equal(blend.screen(0, 128), 128);
  assert.ok(Math.abs(blend.softLight(128, 128) - 128) < 0.5, 'neutral grey is a no-op');
  assert.equal(blend.linearLight(100, 127.5), 100, 'neutral detail layer is lossless');
  // Linear Light doubles the offset around the 127.5 neutral point
  assert.equal(blend.linearLight(101, 118), 101 + (118 - 127.5) * 2);
  assert.equal(blend.linearLight(101, 138), 101 + (138 - 127.5) * 2);
  // the frequency-separation pair reconstructs the original exactly
  const lowPass = 120.5;
  const original = 137;
  const texture = (original - lowPass) * 0.5 + blend.LINEAR_NEUTRAL;
  assert.ok(Math.abs(blend.linearLight(lowPass, texture) - original) < 1e-9);
});

test('softLightOffset produces exactly the requested number of levels', () => {
  for (const base of [40, 96, 150, 210]) {
    for (const delta of [3, 8, 20]) {
      const layer = blend.softLightOffset(base, delta);
      const applied = blend.softLight(base, layer) - base;
      assert.ok(Math.abs(applied - delta) <= 1.5, `base ${base} delta ${delta} -> ${applied}`);
    }
  }
});

test('morphology erode/dilate/median/guided behave as expected', () => {
  const src = new Float32Array([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const d = dilate(src, 4, 4, 1);
  const e = erode(src, 4, 4, 1);
  assert.equal(d[5], 1);
  assert.equal(e[10], 0, 'erode removes the isolated bright pixel');
  assert.equal(e[5], 0);
  const noisy = new Float32Array([0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(medianFilter(noisy, 4, 4, 1)[5], 0, 'median removes a spike');
  const flat = guidedFilter(src, new Float32Array(16), 4, 4, 1, 0.001);
  assert.equal(flat.length, 16);
  const mean = boxMean(new Float32Array([2, 2, 2, 2]), 2, 2, 1);
  assert.ok(Math.abs(mean[0] - 2) < 1e-6);
  const soft = softThreshold(new Float32Array([0, 0.5, 1]), 0.25, 0.75);
  assert.ok(soft[0] === 0 && soft[2] === 1 && Math.abs(soft[1] - 0.5) < 1e-6);
});

test('utility maths is deterministic and bounded', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 3);
  const k = gaussianKernel1D(2);
  const sum = k.kernel.reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-5);
  const rng = makeRng(42);
  const a = rng();
  const rng2 = makeRng(42);
  assert.equal(a, rng2());
  assert.ok(a >= 0 && a < 1);
});

const variance = (arr) => {
  let mean = 0;
  for (const v of arr) mean += v;
  mean /= arr.length;
  let s = 0;
  for (const v of arr) s += (v - mean) ** 2;
  return s / arr.length;
};
