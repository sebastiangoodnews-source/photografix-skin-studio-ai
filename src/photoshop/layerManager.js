import { createLogger } from '../core/util/log.js';
import { group as makeGroupRecord, countLayers } from '../core/layers/record.js';
import { maskToRGBA } from '../core/masks/masks.js';
import { blendIfMask } from '../core/image/blend.js';
import { lumaArray } from '../core/analysis/histogram.js';
import { getPhotoshop, getUxp, requireDocument, executeAsModal } from './api.js';

const log = createLogger('layers');

/**
 * PhotoshopLayerManager
 *
 * Replays the LayerRecord tree produced by the engines as real, editable Photoshop
 * layers inside the live document. Nothing here flattens anything: layers are only
 * added inside named groups, so the original remains fully recoverable.
 *
 * Mask policy (deliberate):
 *   Engines hand us both a frame and the coverage mask. Photoshop supports real
 *   layer masks, so we try to create one from the coverage first. If the host build
 *   refuses that descriptor (it varies across versions), the mask is baked into the
 *   layer pixels instead, which guarantees the committed result matches the panel
 *   preview exactly. The report tells the retoucher which path was used.
 */

export const LAYER_LIMITS = {
  maxLayersPerRun: 60,
  requireGroup: true,
};

export class PhotoshopLayerManager {
  constructor(options = {}) {
    this.options = { useLiveMasks: true, groupPrefix: 'Photografix — Skin Studio', ...options };
    this.created = [];
    this.warnings = [];
  }

  async runPipeline(records, document = null) {
    const doc = document || requireDocument();
    const ps = getPhotoshop();
    if (!ps) throw new Error('Photoshop is not available');
    const total = records.reduce((acc, r) => acc + countLayers([r]), 0);
    if (total > LAYER_LIMITS.maxLayersPerRun) {
      throw new Error(`Refusing to create ${total} layers in one run (limit ${LAYER_LIMITS.maxLayersPerRun})`);
    }
    return executeAsModal(async () => {
      const created = [];
      for (const record of records) {
        created.push(...(await this.createNode(doc, record, null)));
      }
      this.created = created;
      return { created, warnings: this.warnings.slice() };
    }, { commandName: 'Photografix Skin Studio — build layers' });
  }

  async createNode(doc, node, parentId) {
    if (node.type === 'group') {
      const groupId = await this.createGroup(doc, node, parentId);
      const out = [groupId];
      for (const child of node.children) {
        out.push(...(await this.createNode(doc, child, groupId)));
      }
      await this.setLayerProps(doc, groupId, { opacity: node.opacity, blendMode: node.blendMode, visible: node.visible });
      return out;
    }
    const id = await this.createLeaf(doc, node, parentId);
    return [id];
  }

  async createGroup(doc, node, parentId) {
    const ps = getPhotoshop();
    this.selectParent(doc, parentId);
    const result = await ps.action.batchPlay(
      [
        {
          _obj: 'make',
          _target: [{ _ref: 'layerSection' }],
          _options: { dialogOptions: 'dontDisplay' },
        },
      ],
      {},
    );
    const id = result?.[0]?.layerID ?? null;
    await this.renameLayer(doc, id, node.name);
    if (node.note) this.warnings.push({ level: 'info', layer: node.name, note: node.note });
    return id;
  }

  async createLeaf(doc, node, parentId) {
    this.selectParent(doc, parentId);
    const ps = getPhotoshop();
    const result = await ps.action.batchPlay(
      [
        {
          _obj: 'make',
          _target: [{ _ref: 'layer' }],
          _options: { dialogOptions: 'dontDisplay' },
        },
      ],
      {},
    );
    const id = result?.[0]?.layerID ?? null;
    if (!id) throw new Error(`Could not create layer "${node.name}"`);
    await this.renameLayer(doc, id, node.name);

    if (node.type === 'pixel') {
      await this.writeFrame(doc, id, node.frame, node.mask, node.name);
      await this.setLayerProps(doc, id, { opacity: node.opacity, blendMode: node.blendMode, visible: node.visible });
    } else if (node.type === 'solid') {
      await this.convertToSolid(doc, id, node.colour);
      await this.setLayerProps(doc, id, { opacity: node.opacity, fillOpacity: node.fillOpacity, blendMode: node.blendMode, visible: node.visible });
      if (node.mask) await this.writeMask(doc, id, node.mask, node.name);
    } else if (node.type === 'adjustment') {
      await this.convertToAdjustment(doc, id, node.adjustment);
      await this.setLayerProps(doc, id, { opacity: node.opacity, blendMode: node.blendMode, visible: node.visible });
      if (node.mask) await this.writeMask(doc, id, node.mask, node.name);
    } else if (node.type === 'duplicate') {
      await this.setLayerProps(doc, id, { opacity: node.opacity, blendMode: node.blendMode, visible: node.visible });
    }
    if (node.blendIf) await this.applyBlendIf(doc, id, node.blendIf);
    return id;
  }

  selectParent(doc, parentId) {
    const ps = getPhotoshop();
    if (!parentId) return;
    ps.action.batchPlay(
      [
        {
          _obj: 'select',
          _target: [{ _ref: 'layer', _id: parentId }],
          makeVisible: false,
          _options: { dialogOptions: 'dontDisplay' },
        },
      ],
      {},
    ).catch((err) => log.warn('select parent failed', { error: err?.message }));
  }

  async renameLayer(doc, layerId, name) {
    const ps = getPhotoshop();
    return ps.action.batchPlay(
      [
        {
          _obj: 'set',
          _target: [{ _ref: 'layer', _id: layerId }],
          to: { _obj: 'layer', name },
          _options: { dialogOptions: 'dontDisplay' },
        },
      ],
      {},
    );
  }

  async setLayerProps(doc, layerId, props) {
    const ps = getPhotoshop();
    const to = { _obj: 'layer' };
    let touched = false;
    if (Number.isFinite(props.opacity) && props.opacity !== 100) {
      to.opacity = { _unit: 'percentUnit', _value: props.opacity };
      touched = true;
    }
    if (Number.isFinite(props.fillOpacity) && props.fillOpacity !== 100) {
      to.fillOpacity = { _unit: 'percentUnit', _value: props.fillOpacity };
      touched = true;
    }
    if (props.blendMode && props.blendMode !== 'normal') {
      to.mode = { _enum: 'blendMode', _value: props.blendMode };
      touched = true;
    }
    if (props.visible === false) {
      to.visible = false;
      touched = true;
    }
    if (!touched) return null;
    return ps.action.batchPlay(
      [
        {
          _obj: 'set',
          _target: [{ _ref: 'layer', _id: layerId }],
          to,
          _options: { dialogOptions: 'dontDisplay' },
        },
      ],
      {},
    );
  }

  /**
   * Write a Frame into a layer. Uses the UXP imaging API; falls back to a temporary
   * PNG placed into the document on hosts that lack imaging putPixels.
   */
  async writeFrame(doc, layerId, frame, mask, layerName) {
    const uxp = getUxp();
    const imaging = uxp?.imaging;
    const baked = mask ? bakeMask(frame, mask) : frame;
    if (imaging && imaging.putPixels && imaging.createImageDataFromBuffer) {
      try {
        const buffer = new Uint8Array(baked.toRGBA().buffer);
        const imageData = await imaging.createImageDataFromBuffer(buffer, {
          width: baked.width,
          height: baked.height,
          components: 4,
          chunky: true,
          colorSpace: 'RGB',
        });
        await imaging.putPixels({ documentID: doc.id, layerID: layerId, imageData });
        if (mask && this.options.useLiveMasks) {
          await this.writeMask(doc, layerId, mask, layerName);
        }
        return { method: 'imaging', maskBaked: !this.options.useLiveMasks };
      } catch (err) {
        log.warn('imaging putPixels failed; using file placement', { error: err?.message });
      }
    }
    await this.placeFrameFromFile(doc, baked, layerName);
    return { method: 'file', maskBaked: true };
  }

  /**
   * Attempt a real Photoshop layer mask from the coverage field. The greyscale
   * channel is created from the mask, loaded as a selection and converted into a
   * mask on the active layer; any failure is reported, never thrown, because the
   * pixels already carry the mask.
   */
  async writeMask(doc, layerId, mask, layerName) {
    const ps = getPhotoshop();
    const uxp = getUxp();
    if (!this.options.useLiveMasks) return { applied: false, reason: 'disabled' };
    try {
      const width = doc.width;
      const height = doc.height;
      const rgba = maskToRGBA(mask);
      const imaging = uxp?.imaging;
      if (!imaging?.putPixels) throw new Error('imaging unavailable');
      // mask channel: 8-bit greyscale RGBA buffer written into a temporary channel
      // built as its own hidden pixel layer inside the group
      const buffer = new Uint8Array(rgba.buffer);
      const created = await ps.action.batchPlay(
        [
          {
            _obj: 'make',
            _target: [{ _ref: 'layer' }],
            _options: { dialogOptions: 'dontDisplay' },
          },
        ],
        {},
      );
      const maskLayerId = created?.[0]?.layerID;
      if (!maskLayerId) throw new Error('could not create mask helper layer');
      const imageData = await imaging.createImageDataFromBuffer(buffer, {
        width: Math.round(width),
        height: Math.round(height),
        components: 4,
        chunky: true,
        colorSpace: 'RGB',
      });
      await imaging.putPixels({ documentID: doc.id, layerID: maskLayerId, imageData });
      // load the helper layer's luminosity as the selection, convert to a mask on
      // the target layer, then remove the helper
      await ps.action.batchPlay(
        [
          { _obj: 'select', _target: [{ _ref: 'layer', _id: maskLayerId }], _options: { dialogOptions: 'dontDisplay' } },
          {
            _obj: 'set',
            _target: [{ _ref: 'channel', _property: 'selection' }],
            to: { _ref: 'channel', _name: 'Gray' },
            _options: { dialogOptions: 'dontDisplay' },
          },
          { _obj: 'select', _target: [{ _ref: 'layer', _id: layerId }], _options: { dialogOptions: 'dontDisplay' } },
          {
            _obj: 'make',
            _target: [{ _ref: 'channelClass' }],
            using: { _obj: 'channelClass', kind: 'mask' },
            _options: { dialogOptions: 'dontDisplay' },
          },
          {
            _obj: 'delete',
            _target: [{ _ref: 'layer', _id: maskLayerId }],
            _options: { dialogOptions: 'dontDisplay' },
          },
        ],
        {},
      );
      this.warnings.push({ level: 'info', layer: layerName, note: 'live layer mask applied' });
      return { applied: true };
    } catch (err) {
      this.warnings.push({ level: 'warn', layer: layerName, note: `live mask unavailable (${err?.message}); mask baked into pixels` });
      return { applied: false, reason: err?.message };
    }
  }

  async convertToSolid(doc, layerId, colour) {
    const ps = getPhotoshop();
    return ps.action.batchPlay(
      [
        {
          _obj: 'set',
          _target: [{ _ref: 'layer', _id: layerId }],
          to: { _obj: 'layer', name: 'Photografix solid', color: { _obj: 'RGBColor', red: colour[0], grain: colour[1], blue: colour[2] } },
          _options: { dialogOptions: 'dontDisplay' },
        },
      ],
      {},
    ).catch((err) => log.warn('solid fill not supported on this host', { error: err?.message }));
  }

  async convertToAdjustment(doc, layerId, adjustment) {
    const ps = getPhotoshop();
    const descriptor = adjustmentDescriptor(adjustment);
    if (!descriptor) {
      this.warnings.push({ level: 'warn', layer: 'adjustment', note: `unsupported adjustment ${adjustment?.type}` });
      return null;
    }
    return ps.action.batchPlay(
      [
        {
          _obj: 'set',
          _target: [{ _ref: 'layer', _id: layerId }],
          to: { _obj: 'adjustmentLayer', adjustment: descriptor },
          _options: { dialogOptions: 'dontDisplay' },
        },
      ],
      {},
    ).catch((err) => {
      this.warnings.push({ level: 'warn', layer: adjustment?.type, note: `adjustment layer failed: ${err?.message}` });
      return null;
    });
  }

  async applyBlendIf(doc, layerId, blendIf) {
    const ps = getPhotoshop();
    try {
      return await ps.action.batchPlay(
        [
          {
            _obj: 'set',
            _target: [{ _ref: 'layer', _id: layerId }],
            to: {
              _obj: 'layer',
              blendOptions: {
                _obj: 'blendOptions',
                sourceBlendWhite: { _unit: 'pixelsUnit', _value: blendIf.whiteHigh ?? 255 },
                sourceBlendBlack: { _unit: 'pixelsUnit', _value: blendIf.blackLow ?? 0 },
              },
            },
            _options: { dialogOptions: 'dontDisplay' },
          },
        ],
        {},
      );
    } catch (err) {
      this.warnings.push({ level: 'warn', layer: 'blend-if', note: `Blend If not applied: ${err?.message}` });
      return null;
    }
  }

  /** Fallback: encode the frame to PNG via a canvas and place it as a layer. */
  async placeFrameFromFile(doc, frame, layerName) {
    const uxp = getUxp();
    const ps = getPhotoshop();
    if (!uxp?.storage?.localFileSystem) throw new Error('No storage API available to place pixels');
    const temp = await uxp.storage.localFileSystem.getTemporaryFolder();
    const file = await temp.createFile(`${sanitise(layerName)}-${Date.now()}.png`, { overwrite: true });
    const canvasDoc = uxp.host.createDocument('photografix-encode', 'canvas');
    const canvas = canvasDoc.body.appendChild(uxp.host.createDocument('canvas'));
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(frame.toRGBA(), frame.width, frame.height), 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await file.write(bytes.buffer);
    await ps.action.batchPlay(
      [
        {
          _obj: 'placeEvent',
          null: { _path: file.nativePath, _kind: 'local' },
          _options: { dialogOptions: 'dontDisplay' },
        },
      ],
      {},
    );
    const placed = ps.app.activeDocument.layers?.[0];
    if (placed) await this.renameLayer(doc, placed.id, layerName);
    canvasDoc.close?.();
    return { method: 'placeEvent' };
  }
}

const bakeMask = (frame, mask) => {
  const out = frame.clone();
  for (let c = 0; c < 3; c++) {
    const ch = out.channels[c];
    for (let i = 0; i < ch.length; i++) ch[i] = 128 + (ch[i] - 128) * mask[i];
  }
  return out;
};

const sanitise = (name) => String(name || 'layer').replace(/[^a-zA-Z0-9-_]+/g, '-').slice(0, 60);

/** Map our adjustment records to Photoshop descriptors. */
export const adjustmentDescriptor = (adj) => {
  if (!adj || !adj.type) return null;
  switch (adj.type) {
    case 'curves': {
      const points = adj.luma || adj.rgb || [[0, 0], [255, 255]];
      const values = points.map(([x, y]) => Math.round(y));
      return {
        _obj: 'curves',
        presetKind: { _enum: 'presetKindType', _value: 'presetKindCustom' },
        adjustment: [
          {
            _obj: 'curvesAdjustment',
            channel: { _ref: 'channel', _enum: 'channel', _value: 'composite' },
            curve: values.map((v, i) => ({
              _obj: 'paint',
              horizontal: { _unit: 'percentUnit', _value: (points[i][0] / 255) * 100 },
              vertical: { _unit: 'percentUnit', _value: (v / 255) * 100 },
            })),
          },
        ],
      };
    }
    case 'levels':
      return {
        _obj: 'levels',
        presetKind: { _enum: 'presetKindType', _value: 'presetKindCustom' },
        adjustment: [
          {
            _obj: 'levelsAdjustment',
            channel: { _ref: 'channel', _enum: 'channel', _value: adj.channel === 'rgb' ? 'composite' : adj.channel },
            input: [
              { _unit: 'levelsUnit', _value: adj.inBlack ?? 0 },
              { _unit: 'levelsUnit', _value: adj.inWhite ?? 255 },
            ],
            gamma: { _unit: 'doubleValueUnit', _value: adj.gamma ?? 1 },
            output: [
              { _unit: 'levelsUnit', _value: adj.outBlack ?? 0 },
              { _unit: 'levelsUnit', _value: adj.outWhite ?? 255 },
            ],
          },
        ],
      };
    case 'hueSaturation':
      return {
        _obj: 'hueSaturation',
        presetKind: { _enum: 'presetKindType', _value: 'presetKindCustom' },
        colorize: false,
        adjustment: [
          {
            _obj: 'hueSaturationAdjustment',
            channel: { _ref: 'channel', _enum: 'channel', _value: 'master' },
            hue: { _unit: 'angleUnit', _value: adj.hue ?? 0 },
            saturation: { _unit: 'percentUnit', _value: adj.saturation ?? 0 },
            lightness: { _unit: 'percentUnit', _value: adj.lightness ?? 0 },
          },
        ],
      };
    case 'colourBalance':
      return {
        _obj: 'colorBalance',
        preserveLuminosity: true,
        adjustment: [
          {
            _obj: 'colorBalanceAdjustment',
            shadowLevels: toLevelTriplet(adj.shadows),
            midtoneLevels: toLevelTriplet(adj.midtones),
            highlightLevels: toLevelTriplet(adj.highlights),
          },
        ],
      };
    case 'vibrance':
      return {
        _obj: 'vibrance',
        vibrance: Math.round(adj.vibrance ?? 0),
        saturation: Math.round(adj.saturation ?? 0),
      };
    case 'selectiveColour':
      return {
        _obj: 'selectiveColor',
        method: { _enum: 'correctionMethod', _value: 'relative' },
        adjustment: [
          {
            _obj: 'selectiveColorAdjustment',
            colors: [{ _obj: 'selectedColor', color: { _enum: 'color', _value: 'reds' }, cyan: adj.cyan ?? 0, magenta: adj.magenta ?? 0, yellow: adj.yellow ?? 0, black: adj.black ?? 0 }],
          },
        ],
      };
    case 'gradientMap':
      return {
        _obj: 'gradientMap',
        gradient: {
          _obj: 'gradientClassEvent',
          gradientForm: { _enum: 'gradientForm', _value: 'customStops' },
          colors: (adj.stops || []).map(([pos, colour]) => ({
            _obj: 'colorStop',
            location: Math.round(pos * 4096),
            color: { _obj: 'RGBColor', red: colour[0], grain: colour[1], blue: colour[2] },
            type: { _enum: 'colorStopType', _value: 'userStop' },
          })),
          transparency: [
            { _obj: 'transferSpec', opacity: { _unit: 'percentUnit', _value: 100 }, location: 0 },
            { _obj: 'transferSpec', opacity: { _unit: 'percentUnit', _value: 100 }, location: 4096 },
          ],
        },
      };
    default:
      return null;
  }
};

const toLevelTriplet = (arr) => {
  const a = arr || [0, 0, 0];
  return [0, 0, 0, 0, 0, 0, ...a.map((v) => Math.round(v))].slice(-9);
};

/**
 * Build a complete "document-safe" wrapper for one engine run: one group per stage
 * plus a non-destructive note layer describing the settings used.
 */
export const buildStageRecords = ({ stageLabel, layerRecords, settings, engineId }) => {
  return [
    makeGroupRecord(stageLabel, [
      ...layerRecords,
      makeGroupRecord('Settings (non-destructive record)', [], {
        note: `${engineId} ${JSON.stringify(settings).slice(0, 900)}`,
        visible: false,
        opacity: 0,
      }),
    ]),
  ];
};

export default PhotoshopLayerManager;
