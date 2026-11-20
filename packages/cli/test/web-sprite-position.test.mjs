// One program places four pictures; on every web skin and on the X16's wasm build the
// sprite table says the same thing and the screenshot lights the same pixels: a step of
// one pixel in the program is a step of one pixel in the picture, with no wrap and no
// offset. The pixels are worked out here from the picture rules and the positions, not
// read from another build.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

import { compile } from '../src/build.mjs';
import { captureScreenshot } from '../src/screenshot.mjs';
import { encodePNG } from '../src/png.mjs';
import { runProgram } from '../src/wasm-host.mjs';
import { BORDER_PX, PET_GREEN, layoutFromHardware, layoutForRealMachine } from '../src/web-layout.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const ENTRY_BYTES = 10;
const CROP_W = 176;
const CROP_H = 184;
const WHITE = '#ffffff';

// The four pictures, in slot order: the rule that lights a pixel, the size and where the program places them.
const SPRITES = [
  { name: 'bar', size: 16, at: [37, 23], tint: 255, lit: (x, y) => x < 8 || y < 4 },
  { name: 'dot', size: 8, at: [101, 150], tint: 2, lit: (x, y) => x + y < 8 },
  { name: 'box', size: 32, at: [136, 144], tint: 255, lit: (x, y) => x === 0 || y === 0 || x === 31 || y === 31 || x === y },
  { name: 'edge', size: 16, at: [168, 176], tint: 255, lit: (x, y) => (x + y) % 3 === 0 },
];

const ART = SPRITES.flatMap(({ name, size }) => [
  `sprite ${name} {`,
  `  source "./${name}.png"`,
  `  size ${size}x${size}`,
  '  transparent auto',
  '}',
]).join('\n') + '\n';

const PROGRAM = [
  'use @8bitscript::screen::screen;',
  'use @8bitscript::graphics::graphics;',
  `use self::art::{${SPRITES.map((s) => s.name).join(', ')}};`,
  '',
  'pub fn main() {',
  '    screen::blank();',
  ...SPRITES.flatMap(({ name, at }) => [
    `    graphics::place(${name}, ${at[0]}, ${at[1]});`,
    ...(name === 'dot' ? ['    graphics::color(dot, 2);'] : []),
  ]),
  '    loop {',
  '        waitFrame();',
  '        graphics::update();',
  '    }',
  '}',
].join('\n');

const TARGETS = [
  ...['hifi', 'hifi-hires', 'pet-2001', 'c64', 'vic20'].map((machine) => ({ name: machine, machine })),
  { name: 'cx16 --web', cx16: true },
];

function image(w, h, lit) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) if (lit(x, y)) rgba.set([255, 255, 255, 255], (y * w + x) * 4);
  }
  return encodePNG(w, h, rgba);
}

/** Every pixel of a PNG this project's own encoder wrote (8 bit RGBA, unfiltered), as one `#rrggbb` string each. */
function decode(png) {
  let idat = Buffer.alloc(0);
  let width = 0;
  let height = 0;
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'PNG bit depth');
      assert.equal(data[9], 6, 'PNG colour type');
    } else if (type === 'IDAT') idat = Buffer.concat([idat, data]);
    at += 12 + length;
  }
  const raw = inflateSync(idat);
  const stride = width * 4;
  const pixels = [];
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (stride + 1)], 0, 'PNG filter');
    const row = [];
    for (let x = 0; x < width; x += 1) {
      const at = y * (stride + 1) + 1 + x * 4;
      row.push('#' + [raw[at], raw[at + 1], raw[at + 2]].map((v) => v.toString(16).padStart(2, '0')).join(''));
    }
    pixels.push(row);
  }
  return pixels;
}

/** Which sprite (index) lights the inner pixel (x, y), or -1. */
function owner(x, y) {
  return SPRITES.findIndex(({ size, at, lit }) => {
    const sx = x - at[0];
    const sy = y - at[1];
    return sx >= 0 && sy >= 0 && sx < size && sy < size && lit(sx, sy);
  });
}

const built = new Map();
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), '8bs-sprite-position-'));
  const prev = process.cwd();
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  try {
    for (const { name, size, lit } of SPRITES) await writeFile(join(dir, `${name}.png`), image(size, size, lit));
    await writeFile(join(dir, 'art.8bg'), ART);
    await writeFile(join(dir, 'main.8bs'), PROGRAM);
    process.chdir(dir);
    for (const target of TARGETS) {
      process.stdout.write = () => true;
      process.stderr.write = () => true;
      let result;
      try {
        result = target.cx16
          ? await compile('cx16', join(dir, 'main.8bs'), { checkout: REPO, web: true })
          : await compile('web', join(dir, 'main.8bs'), { checkout: REPO, hardware: { machine: target.machine } });
      } finally {
        process.stdout.write = out;
        process.stderr.write = err;
      }
      assert.equal(result.ok, true, `${target.name} builds`);
      const layout = target.cx16 ? layoutForRealMachine('cx16', result.hardware) : layoutFromHardware(result.hardware);
      const onFrame = layout.frameOffset >= 0 ? (memory, frame) => { memory[layout.frameOffset] = frame & 255; } : undefined;
      const { memory } = await runProgram(await readFile(result.outFile), { frames: 3, onFrame });
      const mem = new Uint8Array(memory.buffer);
      const slots = [];
      for (let slot = 0; slot < layout.spriteCount; slot += 1) {
        const at = layout.spriteTable + slot * ENTRY_BYTES;
        slots.push([...mem.subarray(at, at + ENTRY_BYTES)]);
      }
      const png = join(dir, `${target.machine ?? 'cx16'}.png`);
      if (target.cx16) await captureScreenshot('cx16', result.outFile, png, { frames: 3, hardware: result.hardware, web: true });
      else await captureScreenshot('web', result.outFile, png, { frames: 3, hardware: result.hardware });
      built.set(target.name, { layout, slots, pixels: decode(await readFile(png)) });
    }
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    process.chdir(prev);
  }
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const u16 = (entry, at) => entry[at] | (entry[at + 1] << 8);

for (const { name } of TARGETS) {
  test(`${name}: the sprite table holds what the program placed`, () => {
    const { layout, slots } = built.get(name);
    SPRITES.forEach(({ name: sprite, size, at, tint }, slot) => {
      const entry = slots[slot];
      const where = `${name}, ${sprite} (slot ${slot})`;
      assert.equal(entry[0] & 1, 1, `${where}: shown`);
      assert.equal(u16(entry, 1), at[0], `${where}: X`);
      assert.equal(u16(entry, 3), at[1], `${where}: Y`);
      assert.equal(entry[5], size, `${where}: W`);
      assert.equal(entry[6], size, `${where}: H`);
      assert.equal(entry[9], tint, `${where}: TINT`);
    });
    for (let slot = SPRITES.length; slot < layout.spriteCount; slot += 1) {
      assert.equal(slots[slot][0] & 1, 0, `${name}: slot ${slot} is not shown`);
    }
  });
}

test('slots 0 to 3 are byte for byte the same on every target', () => {
  const first = built.get(TARGETS[0].name).slots;
  for (const { name } of TARGETS.slice(1)) {
    const { slots } = built.get(name);
    for (let slot = 0; slot < SPRITES.length; slot += 1) {
      assert.deepEqual(slots[slot], first[slot], `${name} slot ${slot} differs from ${TARGETS[0].name}: ${slots[slot]} vs ${first[slot]}`);
    }
  }
});

for (const { name } of TARGETS) {
  test(`${name}: the lit pixels are the ones the rules and positions give`, () => {
    const { pixels } = built.get(name);
    for (let y = 0; y < CROP_H; y += 1) {
      for (let x = 0; x < CROP_W; x += 1) {
        const lit = pixels[BORDER_PX + y][BORDER_PX + x] !== '#000000';
        assert.equal(lit, owner(x, y) >= 0, `${name}: first difference at (${x}, ${y}): ${lit ? 'lit' : 'dark'}, expected ${lit ? 'dark' : 'lit'}`);
      }
    }
  });

  test(`${name}: the lit pixels have the sprite's colour`, () => {
    const { layout, pixels } = built.get(name);
    for (let y = 0; y < CROP_H; y += 1) {
      for (let x = 0; x < CROP_W; x += 1) {
        const slot = owner(x, y);
        if (slot < 0) continue;
        const ink = SPRITES[slot].name === 'dot' ? layout.palette[2] : (name === 'pet-2001' ? PET_GREEN : WHITE);
        const got = pixels[BORDER_PX + y][BORDER_PX + x];
        assert.equal(got, ink, `${name}: first difference at (${x}, ${y}) in ${SPRITES[slot].name}: ${got}, expected ${ink}`);
      }
    }
  });
}
