import zlib from 'node:zlib';

/**
 * Minimal dependency-free PNG encoder (8-bit RGB).
 * Used by the dev harness to dump engine output for visual review.
 */
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
};

export const encodePNG = (width, height, rgb) => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      const dst = rowStart + 1 + x * 3;
      raw[dst] = rgb[src];
      raw[dst + 1] = rgb[src + 1];
      raw[dst + 2] = rgb[src + 2];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
};

export const frameToPNG = (frame) => {
  const n = frame.pixelCount;
  const rgb = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = Math.max(0, Math.min(255, Math.round(frame.r[i])));
    rgb[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(frame.g[i])));
    rgb[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(frame.b[i])));
  }
  return encodePNG(frame.width, frame.height, rgb);
};

/** Side-by-side comparison sheet (before | after), for review artefacts. */
export const comparisonPNG = (before, after, gap = 6) => {
  const width = before.width + after.width + gap;
  const height = Math.max(before.height, after.height);
  const rgb = Buffer.alloc(width * height * 3, 24);
  const blit = (frame, offsetX) => {
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const src = y * frame.width + x;
        const dst = (y * width + x + offsetX) * 3;
        rgb[dst] = Math.max(0, Math.min(255, Math.round(frame.r[src])));
        rgb[dst + 1] = Math.max(0, Math.min(255, Math.round(frame.g[src])));
        rgb[dst + 2] = Math.max(0, Math.min(255, Math.round(frame.b[src])));
      }
    }
  };
  blit(before, 0);
  blit(after, before.width + gap);
  return encodePNG(width, height, rgb);
};
