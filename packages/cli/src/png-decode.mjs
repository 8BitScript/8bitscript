// A whole PNG as RGBA — what `8bs conform` compares two captures with.
//
// png.mjs already reads ONE pixel back (`pixelAt`, for the machine packages'
// hardware probes); a comparison needs every pixel, so this is the same
// decoder with the loop around it: 8 bits a channel; grey, RGB, RGBA,
// grey+alpha or palette; not interlaced. It refuses anything else rather
// than guessing, as pixelAt does.
import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @param {Buffer} buf  the file's bytes
 * @returns {{ width: number, height: number, rgba: Uint8Array }}
 */
export function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let offset = 8;
  let width = 0; let height = 0; let depth = 0; let colorType = 0; let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not 8`);
  if (interlace !== 0) throw new Error('interlaced PNG');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`PNG color type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error('palette PNG without a PLTE chunk');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const line = Buffer.from(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    unfilter(line, previous, filter, channels);
    for (let x = 0; x < width; x += 1) {
      writePixel(rgba, (row * width + x) * 4, line, x * channels, colorType, palette, transparency);
    }
    previous = line;
  }
  return { width, height, rgba };
}

// Undo one row's filter in place; `previous` is the row above, already undone.
function unfilter(line, previous, filter, channels) {
  for (let i = 0; i < line.length; i += 1) {
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
    } else if (filter !== 0) throw new Error(`PNG filter type ${filter}`);
    line[i] = (line[i] + predictor) & 0xff;
  }
}

function writePixel(rgba, o, line, p, colorType, palette, transparency) {
  if (colorType === 0 || colorType === 4) {
    rgba[o] = rgba[o + 1] = rgba[o + 2] = line[p];
    rgba[o + 3] = colorType === 4 ? line[p + 1] : 255;
  } else if (colorType === 3) {
    const index = line[p];
    rgba[o] = palette[index * 3]; rgba[o + 1] = palette[index * 3 + 1]; rgba[o + 2] = palette[index * 3 + 2];
    rgba[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
  } else {
    rgba[o] = line[p]; rgba[o + 1] = line[p + 1]; rgba[o + 2] = line[p + 2];
    rgba[o + 3] = colorType === 6 ? line[p + 3] : 255;
  }
}
