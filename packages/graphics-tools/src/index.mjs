// PNG decode/encode for 8BitGraphics. No Aseprite, GIF, or SVG.
//
// Decode supports 8-bit grey, RGB, indexed, and RGBA, no Adam7. Encode
// writes 8-bit RGBA. Both go through node:zlib for IDAT; the compiler
// never shells out.
import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(data, width, bpp) {
  const stride = width * bpp;
  const out = new Uint8Array(stride * (data.length / (stride + 1)));
  let src = 0;
  let dst = 0;
  let prev = new Uint8Array(stride);
  while (src < data.length) {
    const type = data[src];
    src += 1;
    const row = data.subarray(src, src + stride);
    src += stride;
    const recon = new Uint8Array(stride);
    for (let i = 0; i < stride; i += 1) {
      const x = row[i];
      const a = i >= bpp ? recon[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let val = x;
      if (type === 1) val = (x + a) & 255;
      else if (type === 2) val = (x + b) & 255;
      else if (type === 3) val = (x + ((a + b) >> 1)) & 255;
      else if (type === 4) val = (x + paeth(a, b, c)) & 255;
      else if (type !== 0) throw new Error(`unsupported PNG filter ${type}`);
      recon[i] = val;
    }
    out.set(recon, dst);
    dst += stride;
    prev = recon;
  }
  return out;
}

function readChunks(bytes) {
  if (bytes.length < 8 || !SIGNATURE.equals(bytes.subarray(0, 8))) {
    throw new Error('not a PNG');
  }
  const chunks = [];
  let i = 8;
  while (i + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(i);
    const type = bytes.toString('ascii', i + 4, i + 8);
    const data = bytes.subarray(i + 8, i + 8 + length);
    chunks.push({ type, data });
    i += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

function toRgba(raw, width, height, colorType, palette, transparency) {
  const rgba = new Uint8Array(width * height * 4);
  if (colorType === 6) {
    rgba.set(raw.subarray(0, rgba.length));
    return rgba;
  }
  if (colorType === 2) {
    for (let i = 0, p = 0; i < width * height; i += 1, p += 3) {
      rgba[i * 4] = raw[p];
      rgba[i * 4 + 1] = raw[p + 1];
      rgba[i * 4 + 2] = raw[p + 2];
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }
  if (colorType === 0) {
    for (let i = 0; i < width * height; i += 1) {
      const g = raw[i];
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }
  if (colorType === 3) {
    for (let i = 0; i < width * height; i += 1) {
      const idx = raw[i];
      rgba[i * 4] = palette[idx * 3];
      rgba[i * 4 + 1] = palette[idx * 3 + 1];
      rgba[i * 4 + 2] = palette[idx * 3 + 2];
      rgba[i * 4 + 3] = transparency?.[idx] ?? 255;
    }
    return rgba;
  }
  if (colorType === 4) {
    for (let i = 0, p = 0; i < width * height; i += 1, p += 2) {
      const g = raw[p];
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = raw[p + 1];
    }
    return rgba;
  }
  throw new Error(`unsupported PNG color type ${colorType}`);
}

/**
 * @param {Buffer|Uint8Array} bytes
 * @returns {{ width: number, height: number, rgba: Uint8Array }}
 */
export function decodePng(bytes) {
  const buf = Buffer.from(bytes);
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG has no IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth} is not 8`);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  const plte = chunks.find((c) => c.type === 'PLTE');
  const trns = chunks.find((c) => c.type === 'tRNS');
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const inflated = inflateSync(idat);
  const bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 4 ? 2 : 1;
  const raw = unfilter(inflated, width, bpp);
  const rgba = toRgba(raw, width, height, colorType, plte?.data, trns?.data);
  return { width, height, rgba };
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  typeBuf.copy(header, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([header, data, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    filtered[y * (stride + 1)] = 0;
    Buffer.from(rgba.subarray(y * stride, (y + 1) * stride)).copy(filtered, y * (stride + 1) + 1);
  }
  const idat = deflateSync(filtered);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Slice a sheet into `frameW` × `frameH` frames, left to right then down.
 * @returns {Uint8Array[]} each frame is RGBA of frameW*frameH pixels
 */
export function sliceFrames(rgba, width, height, frameW, frameH) {
  const cols = Math.floor(width / frameW);
  const rows = Math.floor(height / frameH);
  const frames = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const frame = new Uint8Array(frameW * frameH * 4);
      for (let y = 0; y < frameH; y += 1) {
        const src = ((r * frameH + y) * width + c * frameW) * 4;
        frame.set(rgba.subarray(src, src + frameW * 4), y * frameW * 4);
      }
      frames.push(frame);
    }
  }
  return frames;
}

function colorKey(r, g, b, a) {
  if (a < 16) return 't';
  return `${r >> 3},${g >> 3},${b >> 3}`;
}

/**
 * Nearest-color quantize of an RGBA frame to at most `maxColors` opaque
 * colours plus transparency. Returns 1-byte indices (255 = transparent)
 * and an RGB palette.
 */
export function quantize(rgba, maxColors) {
  const counts = new Map();
  const pixels = rgba.length / 4;
  for (let i = 0; i < pixels; i += 1) {
    const o = i * 4;
    const key = colorKey(rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]);
    if (key === 't') continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const palette = ranked.slice(0, Math.max(1, maxColors)).map(([key]) => {
    const [r, g, b] = key.split(',').map((n) => Number(n) * 8);
    return [r, g, b];
  });
  if (!palette.length) palette.push([255, 255, 255]);
  const indices = new Uint8Array(pixels);
  const unique = new Set();
  for (let i = 0; i < pixels; i += 1) {
    const o = i * 4;
    if (rgba[o + 3] < 16) {
      indices[i] = 255;
      continue;
    }
    let best = 0;
    let bestD = Infinity;
    for (let p = 0; p < palette.length; p += 1) {
      const dr = rgba[o] - palette[p][0];
      const dg = rgba[o + 1] - palette[p][1];
      const db = rgba[o + 2] - palette[p][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    indices[i] = best;
    unique.add(best);
  }
  return { indices, palette, colors: unique.size };
}

export function contentHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** Average brightness 0..255 of opaque pixels; 0 if the frame is empty. */
export function brightness(rgba) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 16) continue;
    sum += (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
    n += 1;
  }
  return n ? Math.round(sum / n) : 0;
}

/** Downsample an indices buffer to a w×h bit mask (1 = any opaque). */
export function bitmask(indices, srcW, srcH, dstW, dstH) {
  const bits = [];
  for (let y = 0; y < dstH; y += 1) {
    let row = 0;
    for (let x = 0; x < dstW; x += 1) {
      const x0 = Math.floor((x * srcW) / dstW);
      const x1 = Math.floor(((x + 1) * srcW) / dstW);
      const y0 = Math.floor((y * srcH) / dstH);
      const y1 = Math.floor(((y + 1) * srcH) / dstH);
      let on = false;
      for (let sy = y0; sy < Math.max(y0 + 1, y1) && sy < srcH; sy += 1) {
        for (let sx = x0; sx < Math.max(x0 + 1, x1) && sx < srcW; sx += 1) {
          if (indices[sy * srcW + sx] !== 255) on = true;
        }
      }
      if (on) row |= 1 << (dstW - 1 - x);
    }
    bits.push(row);
  }
  return bits;
}
