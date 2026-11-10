import { clamp } from './math.js';

/**
 * Parameter schema helpers.
 *
 * No processing value is hard-coded in the UI: every module declares its settings
 * here, the panel renders sliders from the schema, and the engine validates its
 * input against the same schema. One source of truth.
 */

export class ParamError extends Error {
  constructor(setting, message) {
    super(`[${setting}] ${message}`);
    this.name = 'ParamError';
    this.setting = setting;
  }
}

export const defineParam = (def) => {
  if (!def.id) throw new Error('defineParam: id required');
  const type = def.type || 'range';
  const p = {
    id: def.id,
    type,
    min: def.min,
    max: def.max,
    step: def.step ?? 1,
    default: def.default,
    unit: def.unit ?? '',
    label: def.label || def.id,
    group: def.group || 'General',
    help: def.help || '',
    advanced: Boolean(def.advanced),
    options: def.options || null,
    visibleWhen: def.visibleWhen || null,
  };
  if (type === 'range') {
    if (!Number.isFinite(p.min) || !Number.isFinite(p.max)) throw new ParamError(def.id, 'range needs numeric min/max');
    if (p.default === undefined) p.default = (p.min + p.max) / 2;
  } else if (type === 'enum') {
    if (!Array.isArray(p.options) || p.options.length === 0) throw new ParamError(def.id, 'enum needs options');
    if (p.default === undefined) p.default = p.options[0].value;
  } else if (type === 'bool') {
    if (p.default === undefined) p.default = false;
  } else if (type === 'colour') {
    if (p.default === undefined) p.default = [128, 128, 128];
  }
  return p;
};

export const defineSchema = (params) => {
  const map = new Map();
  for (const p of params.map(defineParam)) {
    if (map.has(p.id)) throw new Error(`Duplicate param id: ${p.id}`);
    map.set(p.id, p);
  }
  return {
    params: Array.from(map.values()),
    get: (id) => map.get(id),
  };
};

export const defaultsFor = (schema) => {
  const out = {};
  for (const p of schema.params) out[p.id] = Array.isArray(p.default) ? p.default.slice() : p.default;
  return out;
};

export const validate = (schema, values) => {
  const clean = {};
  for (const p of schema.params) {
    let v = values?.[p.id];
    if (v === undefined || v === null) v = Array.isArray(p.default) ? p.default.slice() : p.default;
    if (p.type === 'range') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new ParamError(p.id, `expected number, got ${JSON.stringify(v)}`);
      clean[p.id] = clamp(n, p.min, p.max);
    } else if (p.type === 'enum') {
      // Unknown enum values fall back to the declared default. Presets and saved
      // documents outlive the code that wrote them; a panel must never fail to
      // open because a choice was renamed.
      const ok = p.options.some((o) => o.value === v);
      clean[p.id] = ok ? v : p.default;
    } else if (p.type === 'bool') {
      clean[p.id] = Boolean(v);
    } else if (p.type === 'colour') {
      if (!Array.isArray(v) || v.length !== 3 || v.some((c) => !Number.isFinite(Number(c)))) {
        throw new ParamError(p.id, 'expected [r,g,b]');
      }
      clean[p.id] = v.map((c) => clamp(Math.round(Number(c)), 0, 255));
    } else {
      clean[p.id] = v;
    }
  }
  return clean;
};

export const isVisible = (param, values) => {
  if (!param.visibleWhen) return true;
  const { id, equals, in: inList, min, max } = param.visibleWhen;
  const v = values?.[id];
  if (equals !== undefined) return v === equals;
  if (inList) return inList.includes(v);
  if (min !== undefined || max !== undefined) {
    const n = Number(v);
    return n >= (min ?? -Infinity) && n <= (max ?? Infinity);
  }
  return true;
};
