// Regenerates fixtures/png.json from packages/graphics-tools (the JS oracle).
// Run from the repo root: node crates/media-tools/tests/gen/png.mjs
// Each row is { fn, args, result } or { fn, args, error }. Byte inputs are hex.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  decodePng, sliceFrames, quantize, brightness, bitmask,
} from '../../../../packages/graphics-tools/src/index.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const hex = (b) => Buffer.from(b).toString('hex');
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf) {
  let c = 0xffffffff;
  for (const x of buf) {
    c ^= x;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'latin1');
  const h = Buffer.alloc(8);
  h.writeUInt32BE(data.length, 0);
  t.copy(h, 4);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([h, data, c]);
}
function ihdr(w, h, depth, ct, interlace = 0) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0);
  b.writeUInt32BE(h, 4);
  b[8] = depth;
  b[9] = ct;
  b[12] = interlace;
  return b;
}
// rows: [[filterType, ...bytes], ...]
const idatOf = (rows) => deflateSync(Buffer.from(rows.flat()));
function png({ w, h, depth = 8, ct, interlace = 0, rows, plte, trns, ihdrData, idat, extra = [], iend = true }) {
  const parts = [SIG, chunk('IHDR', ihdrData ?? ihdr(w, h, depth, ct, interlace))];
  if (plte) parts.push(chunk('PLTE', Buffer.from(plte)));
  if (trns) parts.push(chunk('tRNS', Buffer.from(trns)));
  for (const e of extra) parts.push(e);
  parts.push(chunk('IDAT', idat ?? idatOf(rows)));
  if (iend) parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const rows = [];
function decodeRow(name, bytes) {
  const row = { fn: 'decodePng', name, args: [hex(bytes)] };
  try {
    const r = decodePng(bytes);
    row.result = { width: r.width, height: r.height, rgba: [...r.rgba] };
  } catch (e) {
    row.error = e.message;
  }
  rows.push(row);
}

// every PNG under packages/
function walk(dir, out) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.git') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.png')) out.push(p);
  }
  return out;
}
for (const p of walk(join(root, 'packages'), []).sort()) decodeRow(relative(root, p), readFileSync(p));

// synthetic, one per color type, all five filters
decodeRow('grey', png({ w: 3, h: 5, ct: 0, rows: [[0, 1, 2, 3], [1, 4, 5, 6], [2, 7, 8, 9], [3, 10, 11, 12], [4, 13, 14, 15]] }));
decodeRow('rgb', png({ w: 2, h: 5, ct: 2, rows: [[0, 1, 2, 3, 4, 5, 6], [1, 9, 8, 7, 6, 5, 4], [2, 1, 1, 1, 1, 1, 1], [3, 200, 100, 50, 25, 12, 6], [4, 250, 251, 252, 253, 254, 255]] }));
decodeRow('rgba', png({ w: 2, h: 3, ct: 6, rows: [[0, 1, 2, 3, 4, 5, 6, 7, 8], [4, 9, 9, 9, 9, 9, 9, 9, 9], [3, 255, 255, 255, 255, 255, 255, 255, 255]] }));
decodeRow('grey-alpha', png({ w: 2, h: 2, ct: 4, rows: [[0, 10, 20, 30, 40], [1, 1, 2, 3, 4]] }));
decodeRow('indexed-trns', png({ w: 4, h: 1, ct: 3, plte: [255, 0, 0, 0, 255, 0, 0, 0, 255], trns: [128, 64], rows: [[0, 0, 1, 2, 0]] }));
decodeRow('indexed-no-trns', png({ w: 2, h: 1, ct: 3, plte: [1, 2, 3, 4, 5, 6], rows: [[0, 1, 0]] }));
decodeRow('indexed-out-of-palette', png({ w: 3, h: 1, ct: 3, plte: [1, 2, 3], trns: [9], rows: [[0, 0, 5, 200]] }));
decodeRow('extra-chunk-before-idat', png({ w: 1, h: 1, ct: 0, rows: [[0, 77]], extra: [chunk('tEXt', Buffer.from('k\0v'))] }));
decodeRow('no-iend', png({ w: 1, h: 1, ct: 0, rows: [[0, 77]], iend: false }));
decodeRow('split-idat', (() => {
  const z = idatOf([[0, 1, 2], [0, 3, 4]]);
  return Buffer.concat([SIG, chunk('IHDR', ihdr(2, 2, 8, 0)), chunk('IDAT', z.subarray(0, 5)), chunk('IDAT', z.subarray(5)), chunk('IEND', Buffer.alloc(0))]);
})());
decodeRow('trailing-after-zlib', png({ w: 1, h: 1, ct: 0, idat: Buffer.concat([idatOf([[0, 9]]), Buffer.from([1, 2, 3])]) }));
decodeRow('zero-width', png({ w: 0, h: 3, ct: 0, rows: [[0], [0], [0]] }));
decodeRow('zero-size', png({ w: 0, h: 0, ct: 6, rows: [] }));
decodeRow('short-data-ragged', png({ w: 3, h: 2, ct: 0, rows: [[0, 1, 2, 3], [0, 4, 5, 6]] }));
decodeRow('raw-longer-than-image', png({ w: 1, h: 1, ct: 6, rows: [[0, 1, 2, 3, 4]] }));

// each thrown error
decodeRow('err-empty', Buffer.alloc(0));
decodeRow('err-short', Buffer.from([137, 80, 78]));
decodeRow('err-bad-signature', Buffer.concat([Buffer.from('NOTAPNG!'), Buffer.alloc(20)]));
decodeRow('err-no-ihdr', Buffer.concat([SIG, chunk('IDAT', idatOf([[0, 1]])), chunk('IEND', Buffer.alloc(0))]));
decodeRow('err-signature-only', SIG);
decodeRow('err-bit-depth-16', png({ w: 1, h: 1, depth: 16, ct: 0, rows: [[0, 1, 2]] }));
decodeRow('err-bit-depth-1', png({ w: 1, h: 1, depth: 1, ct: 0, rows: [[0, 1]] }));
decodeRow('err-interlaced', png({ w: 1, h: 1, ct: 0, interlace: 1, rows: [[0, 1]] }));
decodeRow('err-color-type-5', png({ w: 1, h: 1, ct: 5, rows: [[0, 1]] }));
decodeRow('err-filter-9', png({ w: 2, h: 1, ct: 0, rows: [[9, 1, 2]] }));
decodeRow('err-filter-5-zero-width', png({ w: 0, h: 1, ct: 0, rows: [[5]] }));
decodeRow('err-indexed-no-plte', png({ w: 2, h: 1, ct: 3, rows: [[0, 1, 0]] }));
decodeRow('err-ihdr-2-bytes', png({ ihdrData: Buffer.from([0, 0]), rows: [[0]] }));
decodeRow('err-ihdr-6-bytes', png({ ihdrData: Buffer.from([0, 0, 0, 1, 0, 0]), rows: [[0]] }));
decodeRow('err-ihdr-9-bytes', png({ ihdrData: Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8]), rows: [[0, 1]] }));
decodeRow('err-ihdr-10-bytes', png({ ihdrData: Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0]), rows: [[0, 1]] }));
decodeRow('err-ihdr-8-bytes', png({ ihdrData: Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), rows: [[0, 1]] }));
decodeRow('err-ihdr-13-short-color', png({ ihdrData: Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8]), rows: [[0, 1]] }));
decodeRow('err-no-idat', Buffer.concat([SIG, chunk('IHDR', ihdr(1, 1, 8, 0)), chunk('IEND', Buffer.alloc(0))]));
decodeRow('err-zlib-header', png({ w: 1, h: 1, ct: 0, idat: Buffer.from([1, 2, 3, 4, 5, 6]) }));
// zlib header bytes with a valid check value: CMF, then the FLG that makes (CMF*256+FLG) % 31 == 0
const zhead = (cmf, flags = 0) => Buffer.from([cmf, flags | (31 - (((cmf << 8) | flags) % 31)) % 31]);
const zhdr = (cmf, flags, tail = []) => png({ w: 1, h: 1, ct: 0, idat: Buffer.concat([zhead(cmf, flags), Buffer.from(tail)]) });
decodeRow('err-zlib-method', zhdr(0x79, 0, [3, 0, 0, 0, 0]));
decodeRow('err-zlib-method-1', zhdr(0x71, 0, [3, 0, 0, 0, 0]));
decodeRow('err-zlib-window', zhdr(0x88, 0, [3, 0, 0, 0, 0]));
decodeRow('err-zlib-window-max', zhdr(0xf8, 0, [3, 0, 0, 0, 0]));
decodeRow('err-zlib-dict-2-bytes', zhdr(0x78, 0x20));
decodeRow('err-zlib-dict-5-bytes', zhdr(0x78, 0x20, [0, 0, 0]));
decodeRow('err-zlib-dict-6-bytes', zhdr(0x78, 0x20, [0, 0, 0, 1]));
decodeRow('err-zlib-dict-with-body', zhdr(0x78, 0x20, [1, 2, 3, 4, 3, 0, 0, 0, 1]));
decodeRow('err-zlib-truncated', png({ w: 4, h: 4, ct: 0, idat: idatOf([[0, 1, 2, 3, 4], [0, 1, 2, 3, 4], [0, 1, 2, 3, 4], [0, 1, 2, 3, 4]]).subarray(0, 10) }));
decodeRow('err-zlib-one-byte', png({ w: 1, h: 1, ct: 0, idat: Buffer.from([0x78]) }));
decodeRow('err-zlib-adler', (() => {
  const z = Buffer.from(idatOf([[0, 1, 2, 3, 4]]));
  z[z.length - 1] ^= 0xff;
  return png({ w: 4, h: 1, ct: 0, idat: z });
})());
decodeRow('err-zlib-block-type', png({ w: 1, h: 1, ct: 0, idat: Buffer.from([0x78, 0x9c, 0x07, 0, 0, 0, 0]) }));
// sizes the JS cannot allocate: V8's own messages
const hugeIhdr = (w, h) => png({ ihdrData: ihdr(w, h, 8, 0), idat: deflateSync(Buffer.alloc(0)) });
decodeRow('err-huge-both-dimensions', hugeIhdr(0xffffffff, 0xffffffff));
decodeRow('err-huge-height', hugeIhdr(0xffffffff, 0x10000));
decodeRow('err-ragged-last-row', png({ w: 3, h: 2, ct: 0, rows: [[0, 1, 2, 3], [0, 4]] }));
decodeRow('err-ragged-one-extra', png({ w: 3, h: 1, ct: 0, rows: [[0, 1, 2, 3], [0]] }));

// frame helpers over a deterministic pattern
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed >>> 16; };
function pattern(w, h, { alphaEvery = 4, few = 0 } = {}) {
  const a = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const r = rnd();
    const v = few ? (r % few) * 40 : r & 255;
    a[i * 4] = v;
    a[i * 4 + 1] = few ? v : (r >> 3) & 255;
    a[i * 4 + 2] = few ? 255 - v : (r >> 5) & 255;
    a[i * 4 + 3] = i % alphaEvery === 0 ? (r % 20) : 255;
  }
  return a;
}
for (const [w, h, fw, fh] of [[8, 4, 4, 4], [7, 5, 3, 2], [4, 4, 4, 4], [4, 4, 8, 8], [9, 3, 1, 1], [6, 6, 2, 3]]) {
  const a = pattern(w, h);
  rows.push({ fn: 'sliceFrames', args: [[...a], w, h, fw, fh], result: sliceFrames(a, w, h, fw, fh).map((f) => [...f]) });
}
// a zero frame width or height has no frames (the JS used to loop forever)
for (const [fw, fh] of [[0, 2], [2, 0], [0, 0]]) {
  const a = new Uint8Array(4 * 4 * 4).fill(9);
  rows.push({ fn: 'sliceFrames', args: [[...a], 4, 4, fw, fh], result: sliceFrames(a, 4, 4, fw, fh).map((f) => [...f]) });
}
for (const [w, h, few, maxColors, alphaEvery] of [[8, 8, 0, 4, 4], [8, 8, 0, 16, 3], [6, 6, 3, 8, 5], [4, 4, 0, 1, 1], [4, 4, 0, 0, 1], [16, 16, 0, 300, 100], [5, 5, 2, 2, 7], [8, 8, 0, 255, 100]]) {
  const a = pattern(w, h, { few, alphaEvery });
  const q = quantize(a, maxColors);
  rows.push({ fn: 'quantize', args: [[...a], maxColors], result: { indices: [...q.indices], palette: q.palette, colors: q.colors } });
}
// ties in the ranking: every colour appears once
{
  const a = Uint8Array.from([8, 0, 0, 255, 16, 0, 0, 255, 24, 0, 0, 255, 32, 0, 0, 255]);
  const q = quantize(a, 2);
  rows.push({ fn: 'quantize', args: [[...a], 2], result: { indices: [...q.indices], palette: q.palette, colors: q.colors } });
}
const bright = [
  [],
  [10, 20, 30, 255],
  [1, 0, 0, 255, 0, 0, 0, 255],
  [1, 1, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255],
  [0, 0, 0, 0, 255, 255, 255, 15],
  [255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 16],
  [1, 0, 0, 255, 1, 0, 0, 255, 0, 0, 0, 255, 2, 2, 1, 255],
];
for (const b of bright) rows.push({ fn: 'brightness', args: [b], result: brightness(Uint8Array.from(b)) });
{ const a = pattern(9, 9); rows.push({ fn: 'brightness', args: [[...a]], result: brightness(a) }); }
for (const [sw, sh, dw, dh, few] of [[8, 8, 8, 8, 2], [16, 16, 8, 8, 3], [10, 7, 4, 3, 2], [3, 3, 8, 8, 2], [64, 8, 33, 2, 2], [40, 4, 32, 4, 2], [8, 8, 40, 1, 2], [5, 5, 0, 2, 2], [5, 5, 2, 0, 2]]) {
  const q = quantize(pattern(sw, sh, { few, alphaEvery: 2 }), 4).indices;
  rows.push({ fn: 'bitmask', args: [[...q], sw, sh, dw, dh], result: bitmask(q, sw, sh, dw, dh) });
}
// indices shorter than the frame: reads past the end count as set
rows.push({ fn: 'bitmask', args: [[255, 255], 4, 4, 2, 2], result: bitmask(Uint8Array.from([255, 255]), 4, 4, 2, 2) });

writeFileSync(fileURLToPath(new URL('../fixtures/png.json', import.meta.url)), `${JSON.stringify(rows)}\n`);
console.log(`png.json: ${rows.length} rows, ${rows.filter((r) => r.error).length} errors`);
