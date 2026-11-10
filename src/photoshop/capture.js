import { Frame } from '../core/image/frame.js';
import { createLogger } from '../core/util/log.js';
import { getPhotoshop, getUxp, requireDocument } from './api.js';

const log = createLogger('capture');

/**
 * Document capture: Photoshop pixels -> Frame.
 *
 * Preferred path: UXP imaging API (getPixels) which returns a flat RGB(A) buffer at
 * a chosen resolution. Fallback: rasterise a flattened duplicate into the panel's
 * canvas and read it back via ImageData. Both paths are a single function so the
 * engines never need to know which one ran.
 *
 * `maxEdge` downsamples during capture, which is what makes panel previews fast on
 * 50MP files without ever reducing the resolution of the committed layer stack.
 */

let scratchCanvas = null;

const getScratchCanvas = () => {
  if (scratchCanvas) return scratchCanvas;
  const uxp = getUxp();
  const doc = uxp?.host?.createDocument?.('photografix-scratch', 'canvas');
  scratchCanvas = doc?.body?.appendChild(uxp.host.createDocument('canvas'));
  return scratchCanvas;
};

export const captureDocument = async (options = {}) => {
  const { maxEdge = 0, includeSelection = true } = options;
  const doc = requireDocument();
  const width = Math.round(doc.width);
  const height = Math.round(doc.height);
  const scale = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(width, height)) : 1;
  const targetW = Math.max(1, Math.round(width * scale));
  const targetH = Math.max(1, Math.round(height * scale));

  try {
    const frame = await captureWithImaging(doc, targetW, targetH);
    return { frame, width: targetW, height: targetH, scale, method: 'imaging', document: { width, height } };
  } catch (err) {
    log.warn('imaging capture failed, falling back to canvas', { error: err?.message });
    const frame = await captureWithCanvas(doc, targetW, targetH);
    return { frame, width: targetW, height: targetH, scale, method: 'canvas', document: { width, height } };
  }
};

const captureWithImaging = async (doc, targetW, targetH) => {
  const uxp = getUxp();
  const ps = getPhotoshop();
  const imaging = uxp?.imaging;
  if (!imaging) throw new Error('uxp.imaging not available');
  const { imageData } = await imaging.getPixels({
    documentID: doc.id,
    targetSize: { width: targetW, height: targetH },
    componentSize: 8,
    colorSpace: 'RGB',
    applyAlpha: true,
  });
  try {
    const components = imageData.components;
    const data = await imageData.getData({ chunky: true });
    const frame = Frame.fromRGBA(targetW, targetH, data);
    if (components === 3) {
      // some hosts return chunky RGB without alpha; rebuild defensively
      const flat = data;
      if (flat.length === targetW * targetH * 3) return Frame.fromRGBFlat(targetW, targetH, flat);
    }
    return frame;
  } finally {
    imageData.dispose?.();
    if (ps?.core) {
      // no-op; kept explicit so the intent (release host memory) is obvious
    }
  }
};

const captureWithCanvas = async (doc, targetW, targetH) => {
  const uxp = getUxp();
  const ps = getPhotoshop();
  if (!uxp || !ps) throw new Error('Canvas capture unavailable: no UXP host');
  const canvasDoc = uxp.host.createDocument('photografix-capture', 'canvas');
  const canvas = canvasDoc.body?.appendChild?.(uxp.host.createDocument('canvas'));
  if (!canvas) throw new Error('Could not create scratch canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  try {
    await ps.core.executeAsModal(
      async () => {
        const commands = [
          { _obj: 'duplicate', _target: [{ _ref: 'document', _id: doc.id }], _options: { dialogOptions: 'dontDisplay' } },
        ];
        await ps.action.batchPlay(commands, {});
      },
      { commandName: 'Photografix capture' },
    );
    const dup = ps.app.activeDocument;
    if (dup) {
      await ps.core.executeAsModal(
        async () => {
          await ps.action.batchPlay(
            [
              { _obj: 'flattenImage', _target: [{ _ref: 'document', _id: dup.id }] },
              { _obj: 'selectAll', _target: [{ _ref: 'document', _id: dup.id }], _options: { dialogOptions: 'dontDisplay' } },
              { _obj: 'copy', _target: [{ _ref: 'document', _id: dup.id }], _options: { dialogOptions: 'dontDisplay' } },
            ],
            {},
          );
        },
        { commandName: 'Photografix flatten copy' },
      );
      const clipboard = uxp.clipboard;
      if (clipboard && clipboard.getContent) {
        const content = await clipboard.getContent();
        if (content) await ctx.drawImage(content, 0, 0, targetW, targetH);
      }
      await ps.core.executeAsModal(
        async () => {
          await dup.closeWithoutSaving();
        },
        { commandName: 'Photografix close copy' },
      );
    }
    const imageData = ctx.getImageData(0, 0, targetW, targetH);
    return Frame.fromRGBA(targetW, targetH, imageData.data);
  } finally {
    try {
      canvasDoc.close?.();
    } catch {
      // scratch document cleanup is best-effort
    }
  }
};

/**
 * Sample the colour under the cursor / at a point (used by reference-based skin
 * tone matching).
 */
export const sampleColour = async (x, y) => {
  const ps = getPhotoshop();
  const doc = requireDocument();
  const px = Math.round(x);
  const py = Math.round(y);
  return ps.core.executeAsModal(
    async () => {
      const result = await ps.action.batchPlay(
        [
          {
            _obj: 'colorSampler',
            _target: [{ _ref: 'colorSamplerClass', _name: 'Photografix sample' }],
            samplePoint: [{ _unit: 'pixelsUnit', _value: px }, { _unit: 'pixelsUnit', _value: py }],
            _options: { dialogOptions: 'dontDisplay' },
          },
        ],
        {},
      );
      return result;
    },
    { commandName: 'Photografix sample colour' },
  ).catch(() => null);
};
