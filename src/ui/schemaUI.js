import { isVisible } from '../core/util/params.js';

/**
 * Schema-driven control rendering.
 *
 * Every slider, dropdown, toggle and colour swatch in the panel is generated from
 * the engine's parameter schema - no processing value is written twice, and a new
 * engine parameter appears in the UI automatically. Controls are grouped, support
 * `visibleWhen` dependencies, and report changes through one callback.
 */

const GROUP_ORDER = ['Regions', 'Region', 'Samples', 'Grade', 'Style', 'Target', 'Preset', 'Quality', 'Palette', 'Bands', 'Separation', 'Texture', 'Colour', 'Tone', 'Balance', 'Tonal colour', 'Zones', 'Anatomy', 'Glow', 'Highlights', 'Lips', 'Contour', 'Sculpt', 'Correction', 'Matching', 'Safeguards', 'Masks', 'Brush', 'Output', 'Engine'];

const groupRank = (name) => {
  const i = GROUP_ORDER.indexOf(name);
  return i === -1 ? GROUP_ORDER.length : i;
};

export class SchemaForm {
  constructor({ schema, values = {}, onChange, onCommit, collapsedGroups = [], documentRef }) {
    this.schema = schema;
    this.values = { ...defaultsFor(schema), ...values };
    this.onChange = onChange || (() => {});
    this.onCommit = onCommit || null;
    this.collapsed = new Set(collapsedGroups);
    this.element = null;
    this.documentRef = documentRef || null;
  }

  render() {
    const root = el('div', { class: 'schema-form' });
    const groups = new Map();
    for (const p of this.schema.params) {
      if (p.advanced && !this.values.__showAdvanced) {
        // advanced params still render, but inside a collapsed "Advanced" group
      }
      const key = p.advanced ? 'Advanced' : p.group || 'General';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const keys = Array.from(groups.keys()).sort((a, b) => groupRank(a) - groupRank(b));
    for (const key of keys) {
      root.appendChild(this.renderGroup(key, groups.get(key)));
    }
    this.element = root;
    this.refreshVisibility();
    return root;
  }

  renderGroup(name, params) {
    const collapsed = this.collapsed.has(name) || name === 'Advanced';
    const groupEl = el('section', { class: `group${collapsed ? ' group--collapsed' : ''}` });
    const title = el('div', { class: 'group__title' });
    title.appendChild(el('span', {}, name));
    title.appendChild(el('span', { class: 'chevron' }, collapsed ? '+' : '–'));
    title.addEventListener('click', () => {
      const isCollapsed = groupEl.classList.toggle('group--collapsed');
      title.querySelector('.chevron').textContent = isCollapsed ? '+' : '–';
      if (isCollapsed) this.collapsed.add(name);
      else this.collapsed.delete(name);
    });
    const body = el('div', { class: 'group__body' });
    for (const p of params) body.appendChild(this.renderField(p));
    groupEl.appendChild(title);
    groupEl.appendChild(body);
    return groupEl;
  }

  renderField(p) {
    const wrapper = el('div', { class: 'field', 'data-param': p.id });
    if (p.type === 'bool') {
      wrapper.classList.add('field--toggle');
      const label = el('label', { class: 'field__label' }, p.label);
      const input = el('input', { type: 'checkbox', id: `p-${this.schema.params[0].id}-${p.id}` });
      input.checked = Boolean(this.values[p.id]);
      input.addEventListener('change', () => this.set(p.id, input.checked, true));
      wrapper.appendChild(label);
      wrapper.appendChild(input);
      if (p.help) wrapper.appendChild(el('div', { class: 'field__help' }, p.help));
      return wrapper;
    }

    const label = el('label', { class: 'field__label', for: `p-${p.id}` }, p.label);
    wrapper.appendChild(label);

    if (p.type === 'range') {
      const valueEl = el('span', { class: 'field__value' }, formatValue(this.values[p.id], p));
      const input = el('input', {
        type: 'range',
        id: `p-${p.id}`,
        min: String(p.min),
        max: String(p.max),
        step: String(p.step),
        value: String(this.values[p.id]),
      });
      input.addEventListener('input', () => {
        const v = Number(input.value);
        valueEl.textContent = formatValue(v, p);
        this.set(p.id, v, false);
      });
      input.addEventListener('change', () => {
        this.set(p.id, Number(input.value), true);
      });
      wrapper.appendChild(valueEl);
      wrapper.appendChild(input);
      if (p.help) wrapper.appendChild(el('div', { class: 'field__help' }, p.help));
      return wrapper;
    }

    if (p.type === 'enum') {
      const select = el('select', { id: `p-${p.id}` });
      for (const opt of p.options) {
        const o = el('option', { value: opt.value }, opt.label);
        if (opt.value === this.values[p.id]) o.selected = true;
        select.appendChild(o);
      }
      select.addEventListener('change', () => this.set(p.id, select.value, true));
      wrapper.appendChild(el('span', {}));
      wrapper.appendChild(select);
      if (p.help) wrapper.appendChild(el('div', { class: 'field__help' }, p.help));
      return wrapper;
    }

    if (p.type === 'colour') {
      const input = el('input', { type: 'color', id: `p-${p.id}`, value: rgbToHex(this.values[p.id]) });
      input.addEventListener('change', () => this.set(p.id, hexToRgb(input.value), true));
      wrapper.appendChild(el('span', {}));
      wrapper.appendChild(input);
      if (p.help) wrapper.appendChild(el('div', { class: 'field__help' }, p.help));
      return wrapper;
    }

    wrapper.appendChild(el('span', { class: 'field__help' }, `Unsupported control type: ${p.type}`));
    return wrapper;
  }

  set(id, value, commit) {
    this.values[id] = value;
    this.refreshVisibility();
    this.onChange(this.values, id);
    if (commit && this.onCommit) this.onCommit(this.values, id);
  }

  setValues(next, { silent = false } = {}) {
    this.values = { ...this.values, ...next };
    this.syncInputs();
    if (!silent) this.onChange(this.values, null);
  }

  syncInputs() {
    if (!this.element) return;
    for (const p of this.schema.params) {
      const field = this.element.querySelector(`[data-param="${p.id}"]`);
      if (!field) continue;
      const input = field.querySelector('input, select');
      if (!input) continue;
      if (p.type === 'bool') input.checked = Boolean(this.values[p.id]);
      else if (p.type === 'colour') input.value = rgbToHex(this.values[p.id]);
      else input.value = this.values[p.id];
      const valueEl = field.querySelector('.field__value');
      if (valueEl && p.type === 'range') valueEl.textContent = formatValue(this.values[p.id], p);
    }
    this.refreshVisibility();
  }

  refreshVisibility() {
    if (!this.element) return;
    for (const p of this.schema.params) {
      const field = this.element.querySelector(`[data-param="${p.id}"]`);
      if (!field) continue;
      const visible = isVisible(p, this.values);
      field.style.display = visible ? '' : 'none';
    }
  }

  getValues() {
    const out = {};
    for (const p of this.schema.params) out[p.id] = this.values[p.id];
    return out;
  }
}

export const defaultsFor = (schema) => {
  const out = {};
  for (const p of schema.params) out[p.id] = Array.isArray(p.default) ? p.default.slice() : p.default;
  return out;
};

const formatValue = (v, p) => {
  if (p.type !== 'range') return String(v);
  const decimals = p.step && p.step < 1 ? (p.step < 0.1 ? 2 : 1) : 0;
  return `${Number(v).toFixed(decimals)}${p.unit ? ` ${p.unit}` : ''}`;
};

export const el = (tag, attrs = {}, text) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'for') node.htmlFor = v;
    else node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
};

const rgbToHex = (rgb) => {
  const arr = Array.isArray(rgb) ? rgb : [128, 128, 128];
  return `#${arr.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
};

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
