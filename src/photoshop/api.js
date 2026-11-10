/**
 * Thin, testable wrapper around the Photoshop UXP globals.
 *
 * Nothing else in the plugin touches `require('photoshop')` directly: keeping the
 * platform surface in one file means every engine and every UI module can be unit
 * tested in Node, and the Photoshop integration has exactly one seam to fake.
 *
 * UXP specifics handled here:
 *  - batchPlay descriptors for layer creation, masks, blend modes, Blend If
 *  - imaging API for pixel capture/put (with a canvas fallback for older hosts)
 *  - documents without Photoshop returning a clear, non-throwing error object
 */

export const HOST_STATE = {
  available: false,
  version: null,
  apiVersion: null,
  imaging: null,
  reason: 'not probed',
};

export const probeHost = () => {
  try {
    const uxp = typeof require === 'function' ? require('uxp') : null;
    const ps = typeof require === 'function' ? require('photoshop') : null;
    if (!ps || !ps.app) {
      HOST_STATE.available = false;
      HOST_STATE.reason = 'photoshop module unavailable';
      return HOST_STATE;
    }
    HOST_STATE.available = true;
    HOST_STATE.version = ps.app.version;
    HOST_STATE.apiVersion = ps.core?.apiVersion ?? null;
    HOST_STATE.imaging = uxp?.imaging || null;
    HOST_STATE.reason = 'ok';
    return HOST_STATE;
  } catch (err) {
    HOST_STATE.available = false;
    HOST_STATE.reason = err?.message || String(err);
    return HOST_STATE;
  }
};

export const getPhotoshop = () => {
  try {
    return typeof require === 'function' ? require('photoshop') : null;
  } catch {
    return null;
  }
};

export const getUxp = () => {
  try {
    return typeof require === 'function' ? require('uxp') : null;
  } catch {
    return null;
  }
};

export const batchPlay = async (commands, options = {}) => {
  const ps = getPhotoshop();
  if (!ps) throw new Error('Photoshop host is not available');
  return ps.action.batchPlay(commands, {
    synchronousExecution: false,
    modalBehavior: 'execute',
    ...options,
  });
};

export const currentDocument = () => {
  const ps = getPhotoshop();
  return ps?.app?.activeDocument || null;
};

export const requireDocument = () => {
  const doc = currentDocument();
  if (!doc) throw new Error('Open a document in Photoshop first');
  return doc;
};

/** Document geometry, resolution and mode - the numbers every engine needs. */
export const documentInfo = () => {
  const doc = currentDocument();
  if (!doc) return null;
  return {
    id: doc.id,
    name: doc.name,
    title: doc.title,
    width: Math.round(doc.width),
    height: Math.round(doc.height),
    resolution: doc.resolution,
    mode: doc.mode,
    bitsPerChannel: doc.bitsPerChannel,
    colorProfileName: doc.colorProfileName,
    layersCount: doc.layers?.length ?? 0,
    selection: describeSelection(doc),
  };
};

const describeSelection = (doc) => {
  try {
    const sel = doc.selection;
    const bounds = sel?.bounds;
    if (!bounds) return null;
    return { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
  } catch {
    return null;
  }
};

export const suspendHistory = async (doc, label, fn) => {
  const ps = getPhotoshop();
  if (!ps || !doc || typeof ps.core?.executeAsModal !== 'function') return fn();
  return ps.core.executeAsModal(
    async () => {
      doc.suspendHistory ? doc.suspendHistory({ name: label }) : null;
      try {
        return await fn();
      } finally {
        doc.suspendHistory ? await doc.suspendHistory() : null;
      }
    },
    { commandName: label },
  );
};

export const executeAsModal = async (fn, options = {}) => {
  const ps = getPhotoshop();
  if (!ps || typeof ps.core?.executeAsModal !== 'function') return fn();
  return ps.core.executeAsModal(fn, { commandName: 'Photografix Skin Studio', ...options });
};
