import { Frame } from '../image/frame.js';
import { rgbToLab, labToRgb } from '../image/colorspace.js';
import { SKIN_TONE_CATEGORIES } from '../engines/africanSkinPalette.js';
import { makeRng } from '../util/math.js';

/**
 * Synthetic portrait generator for tests and the dev harness.
 *
 * Produces a deterministic, anatomically-plausible head-and-shoulders subject with:
 *  - a face ellipse plus neck, chest and arms (so body segmenters have real input)
 *  - directional key light with soft falloff
 *  - pore-scale texture, fine grain, and a handful of blemishes
 *  - darker lip and eye regions, brow line, under-eye shadow
 *
 * It is a test fixture, not a renderer: the point is to exercise the engines'
 * decision paths (skin detection, texture gating, highlight placement) with input
 * that has the same *structure* as a photograph at any resolution.
 *
 * WHY THIS LIVES IN src/ AND NOT tools/: the panel uses it when Photoshop is absent
 * (preview mode). A plugin bundle ships src/ only, so a fixture imported from tools/
 * would break the shipped plugin while every test still passed. Keeping it here also
 * guarantees the bundle can be validated by loading it, not just by reading it.
 */

export const TONE_PRESETS = Object.fromEntries(
  SKIN_TONE_CATEGORIES.map((c) => {
    const rgb = labToRgb(c.lab.L, c.lab.a, c.lab.b);
    return [c.id, { rgb: [Math.round(rgb.r), Math.round(rgb.g), Math.round(rgb.b)], lab: c.lab }];
  }),
);

export const createPortrait = (options = {}) => {
  const opts = /** @type {const} */ ({
    width: 360,
    height: 480,
    tone: 'rich-chocolate',
    seed: 12345,
    texture: 1,
    blemishes: 6,
    light: { x: -0.45, y: -0.6 },
    includeBody: true,
    background: [22, 24, 32],
  });
  const width = options.width ?? opts.width;
  const height = options.height ?? opts.height;
  const tone = options.tone ?? opts.tone;
  const seed = options.seed ?? opts.seed;
  const texture = options.texture ?? opts.texture;
  const blemishes = options.blemishes ?? opts.blemishes;
  const light = options.light ?? opts.light;
  const includeBody = options.includeBody ?? opts.includeBody;
  const background = options.background ?? opts.background;

  const preset = TONE_PRESETS[tone] || TONE_PRESETS['rich-chocolate'];
  const rnd = makeRng(seed);
  const frame = new Frame(width, height);

  const cx = width * 0.5;
  const headCy = height * 0.27;
  const rx = width * 0.19;
  const ry = height * 0.165;
  const chinY = headCy + ry;
  const shoulderY = chinY + height * 0.1;
  const bodyHalf = width * 0.3;

  const inEllipse = (x, y, ex, ey, erx, ery) => {
    const dx = (x - ex) / erx;
    const dy = (y - ey) / ery;
    return dx * dx + dy * dy;
  };

  // Pre-compute blemish positions in the face/body so they are stable.
  const blems = [];
  for (let i = 0; i < blemishes; i++) {
    blems.push({
      x: cx + (rnd() - 0.5) * rx * 1.5,
      y: headCy + (rnd() - 0.5) * ry * 1.3,
      r: 2 + rnd() * Math.max(2, width * 0.011),
      strength: 6 + rnd() * 16,
    });
  }

  const lab = preset.lab;
  const lightLen = Math.hypot(light.x, light.y) || 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;

      // geometry
      const faceD = inEllipse(x, y, cx, headCy, rx, ry);
      const neckW = rx * 0.42;
      const inNeck = y >= chinY - 2 && y <= shoulderY + height * 0.03 && Math.abs(x - cx) < neckW * (1 + (y - chinY) / (height * 0.3));
      const torsoHalf = bodyHalf * (0.75 + ((y - shoulderY) / (height - shoulderY)) * 0.5);
      const inTorso = includeBody && y > shoulderY && Math.abs(x - cx) < torsoHalf;
      const armGap = Math.abs(x - cx) > torsoHalf * 0.72 && Math.abs(x - cx) < torsoHalf * 1.05;
      const inArm = includeBody && y > shoulderY + height * 0.06 && armGap;
      const inSkin = faceD <= 1 || (inNeck && faceD > 0.85) || inTorso || inArm;

      if (!inSkin) {
        frame.r[i] = background[0];
        frame.g[i] = background[1];
        frame.b[i] = background[2];
        continue;
      }

      // Directional shading. `light` is the direction TO the source (screen space,
      // +y down), so an upper-left key light is {x:-0.5, y:-0.6}: surfaces whose
      // normal points that way are lit.
      const nx = (x - cx) / Math.max(1, rx);
      const ny = (y - headCy) / Math.max(1, ry);
      const directional = (nx * light.x + ny * light.y) / lightLen;
      let shade = 0.72 + directional * 0.3;
      if (inTorso || inArm) shade = 0.6 + directional * 0.22 + (1 - (y - shoulderY) / (height - shoulderY)) * 0.12;
      if (inNeck) shade = 0.55 + directional * 0.18;

      // facial feature shading
      let featureDark = 0;
      const eyeY = headCy - ry * 0.12;
      for (const sign of [-1, 1]) {
        const eyeD = inEllipse(x, y, cx + sign * rx * 0.4, eyeY, rx * 0.15, ry * 0.07);
        if (eyeD < 1) featureDark += (1 - eyeD) * 62;
        const browD = inEllipse(x, y, cx + sign * rx * 0.42, eyeY - ry * 0.16, rx * 0.2, ry * 0.035);
        if (browD < 1) featureDark += (1 - browD) * 26;
        const underEye = inEllipse(x, y, cx + sign * rx * 0.38, eyeY + ry * 0.16, rx * 0.22, ry * 0.09);
        if (underEye < 1) featureDark += (1 - underEye) * 13;
      }
      const mouthD = inEllipse(x, y, cx, headCy + ry * 0.45, rx * 0.28, ry * 0.06);
      if (mouthD < 1) featureDark += (1 - mouthD) * 30;
      // nose: slight lateral shadow, brighter bridge
      const noseD = inEllipse(x, y, cx, headCy + ry * 0.02, rx * 0.07, ry * 0.2);
      const noseBridge = noseD < 1 ? 1 - noseD : 0;
      const noseSide = Math.abs(x - cx) > rx * 0.09 && Math.abs(x - cx) < rx * 0.16 && y > headCy - ry * 0.1 && y < headCy + ry * 0.25 ? 10 : 0;

      // pore texture: two-scale deterministic noise
      const n1 = (Math.sin((x * 1.7 + y * 2.3) * 0.9 + seed * 0.001) + Math.sin((x * 0.7 - y * 1.1) * 2.1)) * 0.5;
      const n2 = (rnd() - 0.5) * 2;
      const tex = (n1 * 2.2 + n2 * 1.6) * texture * (faceD < 1 ? 1 : 0.55);

      let blemishDark = 0;
      for (const b of blems) {
        const d = Math.hypot(x - b.x, y - b.y) / b.r;
        if (d < 1) blemishDark += (1 - d * d) * b.strength;
      }

      const brightness = shade * 1.06;
      let r = lab.L;
      // Build a plausible Lab-like colour: L from the palette plus local shading,
      // a/b from the palette plus warmth variation.
      const L = Math.max(3, lab.L * brightness - featureDark - blemishDark + tex * (faceD < 1 ? 0.55 : 0.3) + noseBridge * 3);
      const a = lab.a + directional * 1.2 + noseSide * 0.15 + (n2 * 0.8);
      const b = lab.b + directional * 1.6 + noseSide * 0.25 + (n1 * 1.1);
      const rgb = labToRgb(L, a, b);
      frame.r[i] = rgb.r;
      frame.g[i] = rgb.g;
      frame.b[i] = rgb.b;

      // highlights on forehead/nose/cheek for gloss testing
      const specL = inEllipse(x, y, cx - rx * 0.18, headCy - ry * 0.55, rx * 0.3, ry * 0.13);
      const specNose = inEllipse(x, y, cx, headCy + ry * 0.16, rx * 0.06, ry * 0.08);
      let spec = 0;
      if (specL < 1 && faceD < 1) spec += (1 - specL) * 16;
      if (specNose < 1) spec += (1 - specNose) * 12;
      if (spec > 0) {
        // Soft-knee highlight: brighter skin receives proportionally less so the
        // fixture keeps headroom (a real photograph would have detail there).
        const headroom = Math.max(0, 1 - frame.r[i] / 255);
        const add = spec * headroom * 1.6;
        frame.r[i] += add;
        frame.g[i] += add * 0.96;
        frame.b[i] += add * 0.9;
      }
    }
  }

  return frame;
};

export const SCENARIOS = [
  { id: 'deep-chocolate-studio', tone: 'deep-chocolate', light: { x: -0.5, y: -0.6 }, texture: 1, blemishes: 8, label: 'Deep Chocolate · studio' },
  { id: 'rich-chocolate-portrait', tone: 'rich-chocolate', light: { x: -0.4, y: -0.7 }, texture: 1, blemishes: 6, label: 'Rich Chocolate · portrait' },
  { id: 'dark-ebony-outdoor', tone: 'dark-ebony', light: { x: 0.55, y: -0.5 }, texture: 1.2, blemishes: 5, label: 'Dark Ebony · outdoor light' },
  { id: 'golden-brown-beauty', tone: 'golden-brown', light: { x: -0.35, y: -0.75 }, texture: 0.9, blemishes: 4, label: 'Golden Brown · beauty' },
  { id: 'caramel-maternity', tone: 'caramel', light: { x: 0.3, y: -0.65 }, texture: 0.8, blemishes: 3, label: 'Caramel · maternity' },
  { id: 'neutral-medium-studio', tone: 'neutral-medium', light: { x: -0.45, y: -0.55 }, texture: 0.7, blemishes: 4, label: 'Neutral Medium · studio' },
  { id: 'light-skin-beauty', tone: 'light-skin', light: { x: -0.4, y: -0.6 }, texture: 0.6, blemishes: 5, label: 'Light Skin · beauty' },
  { id: 'fair-skin-flat', tone: 'fair-skin', light: { x: 0, y: -1 }, texture: 0.5, blemishes: 4, label: 'Fair Skin · flat light' },
];
