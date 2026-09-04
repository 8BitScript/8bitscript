// A minimal PNG encoder — just enough to turn a raw RGBA buffer into a
// `.png` file, with no dependency beyond Node's own zlib. Used by the
// `--screenshot` targets that have no emulator-native PNG writer of their
// own to call into (see screenshot.mjs's web target): once a target can
// ask its own emulator to save a PNG (VICE's -exitscreenshot, Xemu's
// -screenshot, FCEUX's gui.savescreenshotas), that's always preferred —
// this exists only for the one target with nothing to ask.
import { deflateSync } from 'node:zlib';

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
