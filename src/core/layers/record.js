/**
 * LayerRecord - the interchange format between the processing engines and
 * Photoshop.
 *
 * Every engine emits a tree of LayerRecords instead of touching Photoshop
 * directly. That gives us three things:
 *   1. the panel preview is rendered from the same records by layer/render.js,
 *      so what the retoucher sees is what the layer stack will contain;
 *   2. records are plain JSON-serialisable data (frames referenced separately),
 *      so automated tests can assert on structure without Photoshop;
 *   3. the Photoshop bridge (photoshop/layerManager.js) is a single interpreter,
 *      not 15 hand-written batchPlay scripts.
 *
 * Nothing here flattens the document: engines only ever add groups/layers.
 */

let counter = 0;
export const resetIds = () => {
  counter = 0;
};
const nextId = (prefix) => `${prefix}-${++counter}`;

export const group = (name, children = [], options = {}) => ({
  type: 'group',
  id: nextId('grp'),
  name,
  visible: options.visible ?? true,
  opacity: options.opacity ?? 100,
  blendMode: options.blendMode ?? 'passThrough',
  children,
  mask: options.mask ?? null,
  note: options.note ?? '',
  locked: options.locked ?? false,
});

export const pixelLayer = (name, frame, options = {}) => ({
  type: 'pixel',
  id: nextId('px'),
  name,
  frame,
  blendMode: options.blendMode ?? 'normal',
  opacity: options.opacity ?? 100,
  fillOpacity: options.fillOpacity ?? 100,
  visible: options.visible ?? true,
  mask: options.mask ?? null,
  blendIf: options.blendIf ?? null,
  clipping: options.clipping ?? false,
  safeguard: options.safeguard ?? false,
  note: options.note ?? '',
});

export const solidLayer = (name, colour, options = {}) => ({
  type: 'solid',
  id: nextId('solid'),
  name,
  colour,
  blendMode: options.blendMode ?? 'normal',
  opacity: options.opacity ?? 100,
  fillOpacity: options.fillOpacity ?? 100,
  visible: options.visible ?? true,
  mask: options.mask ?? null,
  blendIf: options.blendIf ?? null,
  clipping: options.clipping ?? false,
  note: options.note ?? '',
});

export const adjustmentLayer = (name, adjustment, options = {}) => ({
  type: 'adjustment',
  id: nextId('adj'),
  name,
  adjustment,
  blendMode: options.blendMode ?? 'normal',
  opacity: options.opacity ?? 100,
  visible: options.visible ?? true,
  mask: options.mask ?? null,
  blendIf: options.blendIf ?? null,
  clipping: options.clipping ?? false,
  note: options.note ?? '',
});

/** Duplicate of an existing document layer (levels/curves-on-copy workflows). */
export const duplicateLayer = (name, sourceLayerId, options = {}) => ({
  type: 'duplicate',
  id: nextId('dup'),
  name,
  sourceLayerId,
  blendMode: options.blendMode ?? 'normal',
  opacity: options.opacity ?? 100,
  fillOpacity: options.fillOpacity ?? 100,
  visible: options.visible ?? true,
  mask: options.mask ?? null,
  blendIf: options.blendIf ?? null,
  clipping: options.clipping ?? false,
  note: options.note ?? '',
});

export const validateLayerTree = (nodes, path = 'root') => {
  const errors = [];
  const walk = (list, p) => {
    if (!Array.isArray(list)) {
      errors.push(`${p}: children must be an array`);
      return;
    }
    const names = new Set();
    for (const node of list) {
      if (!node || typeof node !== 'object') {
        errors.push(`${p}: layer must be an object`);
        continue;
      }
      if (!node.name) errors.push(`${p}: layer missing name`);
      if (names.has(node.name)) errors.push(`${p}: duplicate layer name "${node.name}"`);
      names.add(node.name);
      if (!Number.isFinite(node.opacity) || node.opacity < 0 || node.opacity > 100) {
        errors.push(`${p}/${node.name}: opacity out of range (${node.opacity})`);
      }
      if (node.mask && !(node.mask instanceof Float32Array)) {
        errors.push(`${p}/${node.name}: mask must be Float32Array`);
      }
      if (node.type === 'group') walk(node.children, `${p}/${node.name}`);
      if (node.type === 'pixel') {
        if (!node.frame || !node.frame.channels) errors.push(`${p}/${node.name}: pixel layer missing frame`);
      }
      if (node.type === 'solid') {
        if (!Array.isArray(node.colour) || node.colour.length !== 3) {
          errors.push(`${p}/${node.name}: solid layer needs [r,g,b]`);
        }
      }
      if (node.type === 'adjustment' && !node.adjustment?.type) {
        errors.push(`${p}/${node.name}: adjustment missing type`);
      }
      if (node.type === 'duplicate' && node.sourceLayerId === undefined) {
        errors.push(`${p}/${node.name}: duplicate missing sourceLayerId`);
      }
    }
  };
  walk(nodes, path);
  return { ok: errors.length === 0, errors };
};

export const countLayers = (nodes) => {
  let n = 0;
  const walk = (list) => {
    for (const node of list) {
      n++;
      if (node.type === 'group') walk(node.children);
    }
  };
  walk(nodes);
  return n;
};

export const collectNames = (nodes, acc = []) => {
  for (const node of nodes) {
    acc.push(node.name);
    if (node.type === 'group') collectNames(node.children, acc);
  }
  return acc;
};

export const findLayer = (nodes, id) => {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.type === 'group') {
      const hit = findLayer(node.children, id);
      if (hit) return hit;
    }
  }
  return null;
};
