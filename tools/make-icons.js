/**
 * Generates the plugin icons the manifest references.
 *
 * Two sizes are declared in manifest.json: a 23px panel icon and a 48px plugin
 * icon, both at 1x and 2x scale. UXP will refuse to load a panel whose declared
 * icon files are missing, so these are build artefacts, not decoration.
 *
 * The mark: a deep-purple disc with a white "skin contour" arc and a warm
 * highlight - readable at 23px, which is the only size that really matters.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodePNG } from './lib/png.js';

const PURPLE_900 = [27, 15, 46];
const PURPLE_600 = [59, 30, 90];
const PURPLE_400 = [107, 63, 160];
const WHITE = [255, 255, 255];
const LILAC = [201, 169, 242];
const WARM = [244, 193, 138];

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Anti-aliased sample of the mark at normalised coordinates (0..1). */
const sample = (u, v, size) => {
  const cx = 0.5;
  const cy = 0.5;
  const dx = u - cx;
  const dy = v - cy;
  const r = Math.hypot(dx, dy);

  // outside the disc: transparent-ish background (kept dark so the panel icon reads
  // on both light and dark Photoshop themes)
  if (r > 0.47) return null;

  const t = Math.min(1, r / 0.47);
  let colour = mix(PURPLE_400, PURPLE_900, Math.pow(t, 0.85));

  // the "cheek contour": an arc across the lower half, drawn as a soft band
  const arcR = 0.30;
  const arcDist = Math.abs(r - arcR);
  const lowerHalf = dy > -0.04;
  if (lowerHalf && arcDist < 0.035) {
    const w = 1 - arcDist / 0.035;
    colour = mix(colour, LILAC, w * 0.85);
  }

  // the highlight: a small warm flare in the upper-left quadrant
  const hx = -0.13;
  const hy = -0.15;
  const hd = Math.hypot(dx - hx, dy - hy);
  if (hd < 0.13) {
    const w = Math.pow(1 - hd / 0.13, 1.7);
    colour = mix(colour, WARM, w * 0.95);
  }

  // a thin white rim keeps the mark legible at 23px
  if (r > 0.435) colour = mix(colour, WHITE, 0.35);

  return colour;
};

const renderIcon = (size) => {
  const px = new Uint8Array(size * size * 3);
  const samples = 4; // supersample for clean edges at tiny sizes
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = (x + (sx + 0.5) / samples) / size;
          const v = (y + (sy + 0.5) / samples) / size;
          const c = sample(u, v, size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          hits++;
        }
      }
      const total = samples * samples;
      const alpha = hits / total;
      // composite onto the plugin's own dark purple so the icon has no baked
      // transparency (UXP handles PNG alpha inconsistently across versions)
      const base = PURPLE_900;
      const fr = hits ? r / hits : base[0];
      const fg = hits ? g / hits : base[1];
      const fb = hits ? b / hits : base[2];
      const out = mix(base, [fr, fg, fb], Math.min(1, alpha * 1.35));
      const i = (y * size + x) * 3;
      px[i] = Math.round(out[0]);
      px[i + 1] = Math.round(out[1]);
      px[i + 2] = Math.round(out[2]);
    }
  }
  return encodePNG(size, size, px);
};

const targets = [
  ['icons/panel.png', 23],
  ['icons/panel@2x.png', 46],
  ['icons/plugin.png', 48],
  ['icons/plugin@2x.png', 96],
];

mkdirSync('icons', { recursive: true });
for (const [path, size] of targets) {
  writeFileSync(path, renderIcon(size));
  console.log(`${path}  ${size}x${size}`);
}

// The manifest declares 23px and 48px entries; UXP resolves @2x automatically.
console.log('icons written');
void PURPLE_600;
