// The sprite compositor of the synthetic web hosts (src/web-sprites.mjs): a pure
// function of a memory image, so each rule is tested on a hand-built one with the
// pixel it must produce written out. The region's layout is web-layout.mjs's
// (agreementFor `sprites`).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { webSprites, webSpritesSource } from '../src/web-sprites.mjs';
import { renderLoader } from '../src/web-loader.mjs';
import {
  DEFAULT_LAYOUT, SPRITE_POOL_BYTES, SpriteField, agreementFor, sidecarJson,
} from '../src/web-layout.mjs';
import { renderFrame, rgbPalette } from '../src/web-scanline.mjs';

const layout = agreementFor({ sprites: true, userGlyphs: true, audio: true });
const W = 64;
const H = 48;
const palette = rgbPalette(layout.palette);
const pack = (r, g, b) => (r << 16) | (g << 8) | b;

function machine() {
  return { mem: new Uint8Array(65536), out: { rgb: new Int32Array(W * H).fill(-1) } };
}

/** Slot `n` shown at (x, y), `w` x `h`, its frame at pool offset `frame`, tint 255 unless given. */
function slot(mem, n, { x, y, w = 8, h = 8, frame = 0, tint = 255, flags = 1 }) {
  const at = layout.spriteTable + n * 10;
  mem[at + SpriteField.FLAGS] = flags;
  mem[at + SpriteField.X] = x & 255;
  mem[at + SpriteField.X + 1] = (x >> 8) & 255;
  mem[at + SpriteField.Y] = y & 255;
  mem[at + SpriteField.Y + 1] = (y >> 8) & 255;
  mem[at + SpriteField.WIDTH] = w;
  mem[at + SpriteField.HEIGHT] = h;
  mem[at + SpriteField.FRAME] = frame & 255;
  mem[at + SpriteField.FRAME + 1] = frame >> 8;
  mem[at + SpriteField.TINT] = tint;
}

/** Fill a frame at pool offset `frame` with one palette index everywhere. */
function solid(mem, frame, w, h, index) {
  mem.fill((index << 4) | index, layout.spritePool + frame, layout.spritePool + frame + (w * h) / 2);
}

/** VERA entry: `GGGGBBBB`, `0000RRRR`. */
function color(mem, n, index, r, g, b) {
  const at = layout.spritePalettes + n * 32 + index * 2;
  mem[at] = (g << 4) | b;
  mem[at + 1] = r;
}

const run = ({ mem, out }) => webSprites(mem, layout, W, H, palette, out);
const px = (out, x, y) => out.rgb[y * W + x];

test('the region follows everything else: table, palettes, then the pool, and reservedEnd is the pool end', () => {
  const plain = agreementFor({ userGlyphs: true, audio: true });
  assert.equal(layout.spriteTable, plain.reservedEnd);
  assert.equal(layout.spritePalettes, layout.spriteTable + 80);
  assert.equal(layout.spritePool, layout.spritePalettes + 256);
  assert.equal(layout.spritePoolBytes, SPRITE_POOL_BYTES);
  assert.equal(layout.reservedEnd, layout.spritePool + SPRITE_POOL_BYTES);
  assert.equal(SPRITE_POOL_BYTES, 16384);
  // Every offset in front of the region stays where it was.
  for (const key of ['charBase', 'colorBase', 'rasterBase', 'glyphBase', 'audioBase', 'hostOffset']) {
    assert.equal(layout[key], plain[key], key);
  }
  const pointed = agreementFor({ pointer: true, frameCounter: true, sprites: true });
  const unpointed = agreementFor({ pointer: true, frameCounter: true });
  assert.equal(pointed.spriteTable, unpointed.reservedEnd, 'after the pointer block');
  assert.equal(plain.spriteTable, -1);
  assert.equal(plain.spritePoolBytes, 0);
});

test('a sprite draws its pixels with the first at its X, Y, left pixel in the high nibble, index 0 clear', () => {
  const m = machine();
  color(m.mem, 0, 1, 15, 0, 0);
  color(m.mem, 0, 2, 0, 15, 0);
  // Row 0, byte 0: left pixel index 1 (high nibble), right pixel index 2 (low).
  m.mem[layout.spritePool] = 0x12;
  // Row 0, byte 1: left clear (0), right index 1.
  m.mem[layout.spritePool + 1] = 0x01;
  slot(m.mem, 0, { x: 10, y: 5 });
  assert.equal(run(m), true);
  assert.equal(px(m.out, 10, 5), pack(255, 0, 0), 'high nibble is the left pixel');
  assert.equal(px(m.out, 11, 5), pack(0, 255, 0), 'low nibble the right');
  assert.equal(px(m.out, 12, 5), -1, 'index 0 is clear');
  assert.equal(px(m.out, 13, 5), pack(255, 0, 0));
  assert.equal(px(m.out, 9, 5), -1, 'left of it');
  assert.equal(px(m.out, 10, 4), -1, 'above it');
  assert.equal(px(m.out, 10, 6), -1, 'row 1 is index 0 too');
});

test('an own-colour pixel is its VERA entry with each 4-bit channel times 17', () => {
  const m = machine();
  color(m.mem, 3, 7, 0x3, 0xa, 0x5);
  solid(m.mem, 0, 8, 8, 7);
  slot(m.mem, 3, { x: 0, y: 0 });
  run(m);
  assert.equal(px(m.out, 0, 0), pack(0x33, 0xaa, 0x55));
  assert.equal(px(m.out, 7, 7), pack(0x33, 0xaa, 0x55));
});

test('a TINT below 16 paints every opaque pixel in that host palette entry; 16 and up are the own colours', () => {
  const m = machine();
  color(m.mem, 0, 1, 15, 15, 15);
  solid(m.mem, 0, 8, 8, 1);
  slot(m.mem, 0, { x: 0, y: 0, tint: 2 });
  run(m);
  assert.equal(px(m.out, 3, 3), pack(...palette[2]), 'a silhouette');
  const own = machine();
  color(own.mem, 0, 1, 15, 15, 15);
  solid(own.mem, 0, 8, 8, 1);
  slot(own.mem, 0, { x: 0, y: 0, tint: 16 });
  run(own);
  assert.equal(px(own.out, 3, 3), pack(255, 255, 255), 'tint 16: the picture\'s own colours');
});

test('slot 0 is in front of slot 1, whatever the order they were written in', () => {
  const m = machine();
  color(m.mem, 0, 1, 15, 0, 0);
  color(m.mem, 1, 1, 0, 0, 15);
  solid(m.mem, 0, 8, 8, 1);
  slot(m.mem, 1, { x: 4, y: 4 });
  slot(m.mem, 0, { x: 0, y: 0 });
  run(m);
  assert.equal(px(m.out, 5, 5), pack(255, 0, 0), 'the overlap is slot 0');
  assert.equal(px(m.out, 10, 10), pack(0, 0, 255), 'slot 1 shows where slot 0 is not');
});

test('a clear pixel of the front slot shows the one behind it', () => {
  const m = machine();
  color(m.mem, 0, 1, 15, 0, 0);
  color(m.mem, 1, 1, 0, 0, 15);
  m.mem.fill(0, layout.spritePool, layout.spritePool + 32); // slot 0's frame: all clear
  solid(m.mem, 32, 8, 8, 1);
  slot(m.mem, 0, { x: 0, y: 0 });
  slot(m.mem, 1, { x: 0, y: 0, frame: 32 });
  run(m);
  assert.equal(px(m.out, 2, 2), pack(0, 0, 255));
});

test('a sprite is clipped at all four edges of the inner picture, with no wrap', () => {
  const edge = (x, y) => {
    const m = machine();
    color(m.mem, 0, 1, 15, 15, 15);
    solid(m.mem, 0, 8, 8, 1);
    slot(m.mem, 0, { x, y });
    run(m);
    let n = 0;
    for (let i = 0; i < W * H; i += 1) if (m.out.rgb[i] !== -1) n += 1;
    return { m, n };
  };
  const left = edge(-3, 10);
  assert.equal(left.n, 5 * 8, 'three columns off the left');
  assert.equal(px(left.m.out, 0, 10), pack(255, 255, 255));
  assert.equal(px(left.m.out, W - 1, 10), -1, 'it does not wrap to the right edge');
  const top = edge(10, -2);
  assert.equal(top.n, 8 * 6);
  assert.equal(px(top.m.out, 10, H - 1), -1, 'nor to the bottom');
  const right = edge(W - 5, 10);
  assert.equal(right.n, 5 * 8);
  assert.equal(px(right.m.out, W - 1, 10), pack(255, 255, 255));
  assert.equal(px(right.m.out, 0, 10), -1);
  const bottom = edge(10, H - 7);
  assert.equal(bottom.n, 8 * 7);
  assert.equal(px(bottom.m.out, 10, H - 1), pack(255, 255, 255));
  assert.equal(px(bottom.m.out, 10, 0), -1);
  assert.equal(edge(W, 0).n, 0, 'wholly off the right');
  assert.equal(edge(0, H).n, 0, 'wholly off the bottom');
  assert.equal(edge(-8, 0).n, 0, 'wholly off the left');
});

test('a 64x64 sprite uses 32 bytes a row and a 16x16 one 8', () => {
  const m = machine();
  color(m.mem, 0, 1, 15, 15, 15);
  // 16 wide: pixel column 15 of row 1 is the low nibble of byte 7 of row 1 (byte 15 of the frame).
  m.mem[layout.spritePool + 8 + 7] = 0x01;
  slot(m.mem, 0, { x: 0, y: 0, w: 16, h: 16 });
  run(m);
  assert.equal(px(m.out, 15, 1), pack(255, 255, 255));
  assert.equal(px(m.out, 14, 1), -1);
  const big = machine();
  color(big.mem, 0, 1, 15, 15, 15);
  big.mem[layout.spritePool + 32 * 63 + 31] = 0x01; // row 63, column 63
  slot(big.mem, 0, { x: 0, y: 0, w: 64, h: 64 });
  webSprites(big.mem, layout, 64, 64, palette, { rgb: big.out.rgb = new Int32Array(64 * 64).fill(-1) });
  assert.equal(big.out.rgb[63 * 64 + 63], pack(255, 255, 255));
});

test('FRAME offsets into the pool', () => {
  const m = machine();
  color(m.mem, 0, 1, 15, 15, 15);
  solid(m.mem, 32, 8, 8, 1);
  slot(m.mem, 0, { x: 0, y: 0, frame: 32 });
  run(m);
  assert.equal(px(m.out, 0, 0), pack(255, 255, 255));
  const first = machine();
  solid(first.mem, 32, 8, 8, 1);
  slot(first.mem, 0, { x: 0, y: 0, frame: 0 });
  assert.equal(run(first), false, 'frame 0 is empty');
});

test('a slot with FLAGS 0 is skipped', () => {
  const m = machine();
  solid(m.mem, 0, 8, 8, 1);
  slot(m.mem, 0, { x: 0, y: 0, flags: 0 });
  assert.equal(run(m), false);
  assert.equal(px(m.out, 0, 0), -1);
  slot(m.mem, 0, { x: 0, y: 0, flags: 0xfe });
  assert.equal(run(m), false, 'only bit 0 shows it');
});

test('a bad WIDTH or HEIGHT is skipped', () => {
  for (const [w, h] of [[0, 8], [8, 0], [12, 8], [8, 24], [128, 8], [8, 128]]) {
    const m = machine();
    solid(m.mem, 0, 8, 8, 1);
    slot(m.mem, 0, { x: 0, y: 0, w, h });
    assert.equal(run(m), false, `${w}x${h}`);
  }
});

test('a FRAME that does not lie inside the pool is skipped', () => {
  const m = machine();
  // Exactly fitting: the last 32 bytes of the pool for an 8x8 (32-byte) frame.
  m.mem.fill(0x11, layout.spritePool + SPRITE_POOL_BYTES - 32, layout.spritePool + SPRITE_POOL_BYTES);
  slot(m.mem, 0, { x: 0, y: 0, frame: SPRITE_POOL_BYTES - 32 });
  assert.equal(run(m), true, 'a frame ending at the last pool byte');
  slot(m.mem, 0, { x: 0, y: 0, frame: SPRITE_POOL_BYTES - 31 });
  assert.equal(run(machine()), false);
  const past = machine();
  slot(past.mem, 0, { x: 0, y: 0, frame: SPRITE_POOL_BYTES - 31 });
  assert.equal(run(past), false, 'one byte too far');
  const far = machine();
  slot(far.mem, 0, { x: 0, y: 0, frame: 65535 });
  assert.equal(run(far), false);
});

test('a host with no sprite region draws nothing', () => {
  const m = machine();
  solid(m.mem, 0, 8, 8, 1);
  assert.equal(webSprites(m.mem, DEFAULT_LAYOUT, W, H, palette, m.out), false);
  assert.equal(webSprites(m.mem, {}, W, H, palette, m.out), false);
});

test('the horizontal scroll and the raster list do not move a sprite', () => {
  const build = (scroll) => {
    const mem = new Uint8Array(65536);
    color(mem, 0, 1, 15, 15, 15);
    solid(mem, 0, 8, 8, 1);
    slot(mem, 0, { x: 20, y: 20 });
    if (scroll) {
      mem[layout.rasterBase] = 0;
      mem[layout.rasterBase + 1] = 2; // Slot.SCROLL_X
      mem[layout.rasterBase + 2] = scroll;
      mem[layout.rasterCountOffset] = 1;
      mem[layout.rasterControlOffset] = 1;
    }
    return renderFrame(mem, { ...layout, border: 0 }, palette);
  };
  const at = (frame, x, y) => frame.rgba.slice((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 3).join();
  for (const scroll of [0, 5]) {
    const frame = build(scroll);
    assert.equal(at(frame, 20, 20), '255,255,255');
    assert.equal(at(frame, 27, 27), '255,255,255');
    assert.equal(at(frame, 28, 28) === '255,255,255', false);
  }
});

test('the sprite layer changes nothing when off, or when no slot is shown', () => {
  const mem = new Uint8Array(65536);
  mem[0] = 2;
  mem[1] = 3;
  mem[layout.charBase] = 65;
  mem[layout.colorBase] = 1;
  const off = agreementFor({ userGlyphs: true, audio: true });
  const a = renderFrame(mem, { ...off, border: 8 }, palette);
  const b = renderFrame(mem, { ...layout, border: 8 }, palette);
  assert.deepEqual(Buffer.from(a.rgba), Buffer.from(b.rgba), 'a region with no shown slot');
  // Even with tables full of data, a cleared FLAGS byte hides it all.
  solid(mem, 0, 8, 8, 1);
  slot(mem, 0, { x: 0, y: 0, flags: 0 });
  const c = renderFrame(mem, { ...layout, border: 8 }, palette);
  assert.deepEqual(Buffer.from(a.rgba), Buffer.from(c.rgba));
  // And a layout without the fields at all (a real machine's) is the unchanged path.
  const bare = { ...off };
  delete bare.spriteTable;
  delete bare.spritePool;
  delete bare.spritePalettes;
  delete bare.spritePoolBytes;
  assert.deepEqual(Buffer.from(renderFrame(mem, { ...bare, border: 8 }, palette).rgba), Buffer.from(a.rgba));
});

test('the sidecar carries the region, and a host without one carries -1', () => {
  const side = sidecarJson(layout);
  assert.equal(side.spriteTable, layout.spriteTable);
  assert.equal(side.spritePalettes, layout.spritePalettes);
  assert.equal(side.spritePool, layout.spritePool);
  assert.equal(side.spritePoolBytes, SPRITE_POOL_BYTES);
  const none = sidecarJson(DEFAULT_LAYOUT);
  assert.equal(none.spriteTable, -1);
  assert.equal(none.spritePoolBytes, 0);
});

test('the generated loader embeds webSpritesSource() and the region addresses', () => {
  const source = renderLoader({ frameRate: 60, layout });
  assert.ok(source.includes(webSpritesSource()), 'the compositor source is embedded verbatim');
  assert.match(source, new RegExp(`var SPRITE_TABLE = ${layout.spriteTable};`));
  assert.match(source, new RegExp(`var SPRITE_POOL_BYTES = ${SPRITE_POOL_BYTES};`));
  assert.match(renderLoader({ frameRate: 60 }), /var SPRITE_TABLE = -1;/);
});
