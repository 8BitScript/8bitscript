// A minimal PNG encoder — just enough to turn a raw RGBA buffer into a
// `.png` file, with no dependency beyond Node's own zlib. Used by the
// `--screenshot` targets that have no emulator-native PNG writer of their
// own to call into (see screenshot.mjs's web target): once a target can
// ask its own emulator to save a PNG (VICE's -exitscreenshot, Xemu's
// -screenshot, FCEUX's gui.savescreenshotas), that's always preferred —
// this exists only for the one target with nothing to ask.
import { deflateSync, inflateSync } from 'node:zlib';

// The standard CRC-32 (IEEE 802.3) table PNG's spec requires for every
// chunk's trailing checksum.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode an RGBA pixel buffer (width*height*4 bytes, row-major, no padding)
 * as a PNG file's bytes — 8-bit-per-channel, no filtering (filter type 0 on
 * every scanline; the image sizes this project draws are small enough that
 * skipping adaptive filtering costs a few hundred bytes, not correctness).
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array | Buffer} rgba
 * @returns {Buffer}
 */
export function encodePNG(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`png: expected ${width * height * 4} bytes for ${width}x${height} RGBA, got ${rgba.length}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type 6 = RGBA
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None) for every row
    Buffer.from(rgba.buffer ?? rgba, rgba.byteOffset ?? 0, rgba.length)
      .copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- and just enough of a decoder to read one pixel back ----------------
//
// The machine packages' hardware probes are verified by running them under
// a real emulator and screenshotting the result: the probe encodes its
// answer as a border color, and the test reads one pixel of the border
// rather than trying to recognize text (see packages/c64/test/reu.test.mjs
// and packages/cx16/test/banks.test.mjs). This reads that pixel. It
// handles what the emulators actually write — 8 bits a channel, RGB, RGBA
// or palette, not interlaced — and throws on anything else rather than
// guessing.

/**
 * The color at (x, y) of a PNG file, as `[r, g, b]`.
 *
 * @param {Buffer} buf  the file's bytes
 * @param {number} x
 * @param {number} y
 * @returns {[number, number, number]}
 */
export function pixelAt(buf, x, y) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(signature)) throw new Error('not a PNG');
  let offset = 8;
  let width = 0; let height = 0; let depth = 0; let colorType = 0; let interlace = 0;
  let palette = null;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not 8`);
  if (interlace !== 0) throw new Error('interlaced PNG');
  if (x >= width || y >= height) throw new Error(`(${x}, ${y}) is outside a ${width}x${height} image`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`PNG color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  // Every row's filter is relative to the row above, so rows up to y have
  // to be undone in order; nothing below y is touched.
  let previous = Buffer.alloc(stride);
  let line = previous;
  for (let row = 0; row <= y; row += 1) {
    const filter = raw[row * (stride + 1)];
    line = Buffer.from(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      }
      line[i] = (line[i] + predictor) & 0xff;
    }
    previous = line;
  }
  if (colorType === 3) {
    const index = line[x];
    return [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]];
  }
  if (channels <= 2) {
    const grey = line[x * channels];
    return [grey, grey, grey];
  }
  return [line[x * channels], line[x * channels + 1], line[x * channels + 2]];
}
