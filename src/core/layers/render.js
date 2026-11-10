import { clamp } from '../util/math.js';
import { MODES, PHOTOSHOP_BLEND_NAMES } from '../image/blend.js';
import { Frame } from '../image/frame.js';

/**
 * Layer stack renderer.
 *
 * Interprets the LayerRecord tree the engines produce and composites it onto a
 * base frame. This is the preview path AND the test oracle: if the stack renders
 * to the same pixels the engine computed directly, the Photoshop bridge can be
 * trusted to produce the same result from the same records.
 */

export const renderStack = (records, baseFrame, options = {}) => {
  const { respectVisibility = true } = options;
  let out = baseFrame.clone();
  out = compositeGroup(records, out, respectVisibility);
  return out;
};

const compositeGroup = (nodes, base, respectVisibility) => {
  let out = base;
  // Records are authored top-of-stack first, like the Photoshop layer panel.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (respectVisibility && node.visible === false) continue;
    if (node.type === 'group') {
      const inner = compositeGroup(node.children, out, respectVisibility);
      out = applyGroupAttributes(out, base, inner, node);
    } else if (node.type === 'pixel') {
      out = compositePixel(out, node);
    } else if (node.type === 'solid') {
      out = compositeSolid(out, node);
    } else if (node.type === 'adjustment') {
      out = compositeAdjustment(out, node);
    } else if (node.type === 'duplicate') {
      // A duplicate of the current composite contributes nothing beyond its own
      // blend/opacity; treat as a normal-mode copy of the base it sits on.
      out = compositeSolid(out, { ...node, type: 'solid', colour: null }, true);
    }
  }
  return out;
};

const applyGroupAttributes = (out, originalBase, groupedResult, node) => {
  const opacity = (node.opacity ?? 100) / 100;
  if (node.blendMode === 'passThrough' || !node.blendMode) {
    if (opacity >= 0.999) return groupedResult;
    const r = new Frame(out.width, out.height);
    for (let c = 0; c < 3; c++) {
      const a = out.channels[c];
      const b = groupedResult.channels[c];
      const o = r.channels[c];
      for (let i = 0; i < o.length; i++) o[i] = a[i] + (b[i] - a[i]) * opacity;
    }
    return r;
  }
  return blendFrames(out, groupedResult, node.blendMode, opacity, node.mask);
};

const blendFrames = (base, top, mode, opacity, mask) => {
  const fn = MODES[mode] || MODES.normal;
  const out = new Frame(base.width, base.height);
  for (let c = 0; c < 3; c++) {
    const b = base.channels[c];
    const t = top.channels[c];
    const o = out.channels[c];
    for (let i = 0; i < o.length; i++) {
      const blended = mode === 'normal' ? t[i] : fn(b[i], t[i]);
      const a = mask ? mask[i] * opacity : opacity;
      o[i] = b[i] + (blended - b[i]) * a;
    }
  }
  return out;
};

const compositePixel = (base, node) => {
  const frame = node.frame;
  if (!frame) return base;
  if (frame.width !== base.width || frame.height !== base.height) {
    throw new RangeError(
      `Layer "${node.name}": frame ${frame.width}x${frame.height} does not match document ${base.width}x${base.height}`,
    );
  }
  const mode = node.blendMode || 'normal';
  const fn = MODES[mode];
  if (!fn) throw new Error(`Layer "${node.name}": unsupported blend mode "${mode}"`);
  const opacity = (node.opacity ?? 100) / 100;
  const fill = (node.fillOpacity ?? 100) / 100;
  const out = new Frame(base.width, base.height);
  for (let c = 0; c < 3; c++) {
    const b = base.channels[c];
    const t = frame.channels[c];
    const o = out.channels[c];
    for (let i = 0; i < o.length; i++) {
      let a = opacity * fill;
      if (node.mask) a *= node.mask[i];
      if (node.blendIf) a *= blendIfFactor(node.blendIf, base, i);
      const blended = mode === 'normal' ? t[i] : fn(b[i], t[i]);
      o[i] = b[i] + (blended - b[i]) * a;
    }
  }
  return out;
};

const compositeSolid = (base, node, skipColour = false) => {
  const out = new Frame(base.width, base.height);
  if (skipColour || !node.colour) return base;
  const mode = node.blendMode || 'normal';
  const fn = MODES[mode] || MODES.normal;
  const opacity = (node.opacity ?? 100) / 100;
  const fill = (node.fillOpacity ?? 100) / 100;
  for (let c = 0; c < 3; c++) {
    const b = base.channels[c];
    const o = out.channels[c];
    const colour = node.colour[c];
    for (let i = 0; i < o.length; i++) {
      let a = opacity * fill;
      if (node.mask) a *= node.mask[i];
      if (node.blendIf) a *= blendIfFactor(node.blendIf, base, i);
      const blended = mode === 'normal' ? colour : fn(b[i], colour);
      o[i] = b[i] + (blended - b[i]) * a;
    }
  }
  return out;
};

const compositeAdjustment = (base, node) => {
  const out = new Frame(base.width, base.height);
  const opacity = (node.opacity ?? 100) / 100;
  const apply = ADJUSTMENTS[node.adjustment?.type];
  if (!apply) throw new Error(`Layer "${node.name}": unsupported adjustment "${node.adjustment?.type}"`);
  for (let i = 0; i < base.pixelCount; i++) {
    const px = { r: base.r[i], g: base.g[i], b: base.b[i] };
    let a = opacity;
    if (node.mask) a *= node.mask[i];
    if (node.blendIf) a *= blendIfFactor(node.blendIf, base, i);
    if (a <= 0) {
      out.r[i] = px.r;
      out.g[i] = px.g;
      out.b[i] = px.b;
      continue;
    }
    const res = apply(px, node.adjustment);
    out.r[i] = px.r + (res.r - px.r) * a;
    out.g[i] = px.g + (res.g - px.g) * a;
    out.b[i] = px.b + (res.b - px.b) * a;
  }
  return out;
};

const blendIfFactor = (blendIf, frame, i) => {
  const L = 0.2126 * frame.r[i] + 0.7152 * frame.g[i] + 0.0722 * frame.b[i];
  const { blackLow = 0, blackHigh = 0, whiteLow = 255, whiteHigh = 255 } = blendIf;
  const lo = blackHigh === blackLow ? (L < blackLow ? 0 : 1) : clamp((L - blackLow) / (blackHigh - blackLow));
  const hi = whiteHigh === whiteLow ? (L > whiteHigh ? 0 : 1) : clamp((whiteHigh - L) / (whiteHigh - whiteLow));
  return Math.min(lo, hi);
};

/** Monotone cubic curve evaluation for the curves adjustment. */
export const buildCurve = (points) => {
  const pts = points.slice().sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const slopes = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i === 0) slopes[i] = (pts[1][1] - pts[0][1]) / Math.max(1e-6, pts[1][0] - pts[0][0]);
    else if (i === n - 1) slopes[i] = (pts[n - 1][1] - pts[n - 2][1]) / Math.max(1e-6, pts[n - 1][0] - pts[n - 2][0]);
    else slopes[i] = (pts[i + 1][1] - pts[i - 1][1]) / Math.max(1e-6, pts[i + 1][0] - pts[i - 1][0]);
  }
  return (x) => {
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[n - 1][0]) return pts[n - 1][1];
    for (let i = 0; i < n - 1; i++) {
      if (x >= pts[i][0] && x <= pts[i + 1][0]) {
        const h = pts[i + 1][0] - pts[i][0];
        const t = (x - pts[i][0]) / h;
        const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
        const h10 = t ** 3 - 2 * t ** 2 + t;
        const h01 = -2 * t ** 3 + 3 * t ** 2;
        const h11 = t ** 3 - t ** 2;
        return clamp(h00 * pts[i][1] + h10 * h * slopes[i] + h01 * pts[i + 1][1] + h11 * h * slopes[i + 1], 0, 255);
      }
    }
    return x;
  };
};

export const ADJUSTMENTS = {
  curves: (px, adj) => {
    const lumaCurve = adj.luma ? buildCurve(adj.luma) : null;
    const rCurve = adj.rgb ? buildCurve(adj.rgb) : null;
    const gCurve = adj.rgb ? buildCurve(adj.rgb) : null;
    const bCurve = adj.rgb ? buildCurve(adj.rgb) : null;
    if (lumaCurve) {
      const L = 0.2126 * px.r + 0.7152 * px.g + 0.0722 * px.b;
      const target = lumaCurve(L);
      const delta = target - L;
      return { r: clamp(px.r + delta, 0, 255), g: clamp(px.g + delta, 0, 255), b: clamp(px.b + delta, 0, 255) };
    }
    return {
      r: clamp(rCurve(px.r), 0, 255),
      g: clamp(gCurve(px.g), 0, 255),
      b: clamp(bCurve(px.b), 0, 255),
    };
  },
  levels: (px, adj) => {
    const { inBlack = 0, inWhite = 255, gamma = 1, outBlack = 0, outWhite = 255, channel = 'rgb' } = adj;
    const map = (v) => {
      const t = clamp((v - inBlack) / Math.max(1e-6, inWhite - inBlack));
      return clamp(outBlack + Math.pow(t, 1 / gamma) * (outWhite - outBlack), 0, 255);
    };
    return {
      r: channel === 'g' || channel === 'b' ? px.r : map(px.r),
      g: channel === 'r' || channel === 'b' ? px.g : map(px.g),
      b: channel === 'r' || channel === 'g' ? px.b : map(px.b),
    };
  },
  hueSaturation: (px, adj) => {
    const { hue = 0, saturation = 0, lightness = 0 } = adj;
    const max = Math.max(px.r, px.g, px.b);
    const avg = (px.r + px.g + px.b) / 3;
    const satFactor = 1 + saturation / 100;
    return {
      r: clamp(avg + (px.r - avg) * satFactor + lightness * 2.55 + hue * 0.15, 0, 255),
      g: clamp(avg + (px.g - avg) * satFactor + lightness * 2.55, 0, 255),
      b: clamp(avg + (px.b - avg) * satFactor + lightness * 2.55 - hue * 0.15, 0, 255),
    };
  },
  colourBalance: (px, adj) => {
    const L = (0.2126 * px.r + 0.7152 * px.g + 0.0722 * px.b) / 255;
    const shadowW = Math.max(0, 1 - L * 2);
    const highlightW = Math.max(0, L * 2 - 1);
    const midW = 1 - shadowW - highlightW;
    const s = adj.shadows || [0, 0, 0];
    const m = adj.midtones || [0, 0, 0];
    const h = adj.highlights || [0, 0, 0];
    const dr = s[0] * shadowW + m[0] * midW + h[0] * highlightW;
    const dg = s[1] * shadowW + m[1] * midW + h[1] * highlightW;
    const db = s[2] * shadowW + m[2] * midW + h[2] * highlightW;
    return { r: clamp(px.r + dr * 1.2, 0, 255), g: clamp(px.g + dg * 1.2, 0, 255), b: clamp(px.b + db * 1.2, 0, 255) };
  },
  vibrance: (px, adj) => {
    const { vibrance = 0, saturation = 0 } = adj;
    const max = Math.max(px.r, px.g, px.b);
    const min = Math.min(px.r, px.g, px.b);
    const sat = max <= 0 ? 0 : (max - min) / max;
    const boost = vibrance * (1 - sat);
    const avg = (px.r + px.g + px.b) / 3;
    const k = 1 + (boost + saturation) / 100;
    return {
      r: clamp(avg + (px.r - avg) * k, 0, 255),
      g: clamp(avg + (px.g - avg) * k, 0, 255),
      b: clamp(avg + (px.b - avg) * k, 0, 255),
    };
  },
  selectiveColour: (px, adj) => {
    const { cyan = 0, magenta = 0, yellow = 0, black = 0 } = adj;
    return {
      r: clamp(px.r - cyan * 1.2 + magenta * 0.3, 0, 255),
      g: clamp(px.g - magenta * 1.2 + yellow * 0.3, 0, 255),
      b: clamp(px.b - yellow * 1.2 + cyan * 0.3 - black * 0.4, 0, 255),
    };
  },
  gradientMap: (px, adj) => {
    const L = (0.2126 * px.r + 0.7152 * px.g + 0.0722 * px.b) / 255;
    const stops = adj.stops;
    for (let i = 0; i < stops.length - 1; i++) {
      const [p0, c0] = stops[i];
      const [p1, c1] = stops[i + 1];
      if (L >= p0 && L <= p1) {
        const t = (L - p0) / Math.max(1e-6, p1 - p0);
        return {
          r: c0[0] + (c1[0] - c0[0]) * t,
          g: c0[1] + (c1[1] - c0[1]) * t,
          b: c0[2] + (c1[2] - c0[2]) * t,
        };
      }
    }
    return px;
  },
};

export const photoshopBlendName = (mode) => PHOTOSHOP_BLEND_NAMES[mode] || 'normal';
