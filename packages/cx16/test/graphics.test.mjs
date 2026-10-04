// @8bitscript/graphics on the X16 — a .8bg picture becomes a VERA hardware
// sprite. Two layers: the media lowering is checked as data (no emulator),
// and, when x16emu and ffmpeg are installed, a program that places three
// sprites is run and every pixel that matters is read off the screenshot.
// packages/cx16/AGENTS.md, "Graphics", has the measurements behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { encodePng } from '../../graphics-tools/src/index.mjs';
import { pixelAt } from '../../cli/src/png.mjs';
import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHECKOUT = join(ROOT, '..', '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');
const require = createRequire(import.meta.url);
const media = require('../media/index.cjs');

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
const HAVE_EMULATOR = onPath('x16emu') && onPath('ffmpeg');

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const YELLOW = [255, 255, 0];
const WHITE = [255, 255, 255];
const MAGENTA = [255, 0, 255];
const CYAN = [0, 255, 255];
const ORANGE = [255, 136, 0];

// An RGBA picture from a function of (x, y) returning [r, g, b] or null.
function picture(width, height, paint) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const c = paint(x, y);
      if (!c) continue;
      rgba.set([c[0], c[1], c[2], 255], (y * width + x) * 4);
    }
  }
  return rgba;
}

// Two 16×16 frames side by side: red|blue with a white pixel at the top
// left and a magenta one at the bottom right, then green|yellow. Nothing in
// it is symmetric, so a flipped axis or swapped nibble cannot pass.
function tagSheet() {
  return picture(32, 16, (x, y) => {
    const f = x < 16 ? 0 : 1;
    const lx = x % 16;
    if (f === 0) {
      if (lx === 0 && y === 0) return WHITE;
      if (lx === 15 && y === 15) return MAGENTA;
      return lx < 8 ? RED : BLUE;
    }
    return lx < 8 ? GREEN : YELLOW;
  });
}

function frameRgba(sheet, sheetW, fx, fw, fh) {
  const rgba = new Uint8Array(fw * fh * 4);
  for (let y = 0; y < fh; y += 1) {
    for (let x = 0; x < fw; x += 1) {
      rgba.set(sheet.subarray(((y * sheetW) + fx * fw + x) * 4, ((y * sheetW) + fx * fw + x) * 4 + 4), (y * fw + x) * 4);
    }
  }
  return { rgba, width: fw, height: fh };
}

const lower = (sprite, frames) => media.lowerGraphics(sprite, frames, {}, 'x.8bg', (code, message) => ({ code, message }));

test('the lowering hands the driver a palette, then linear 4bpp frames with the left pixel in the high nibble', () => {
  const sheet = tagSheet();
  const frames = [frameRgba(sheet, 32, 0, 16, 16), frameRgba(sheet, 32, 1, 16, 16)];
  const out = lower({ name: 'tag', animations: [{ frames: [0, 1], every: 4 }] }, frames);
  assert.equal(out.kind, 5);
  assert.equal(out.frames, 2);
  assert.equal(out.every, 4);
  assert.equal(out.width, 16);
  assert.equal(out.height, 16);
  assert.equal(out.data.length, 32 + 2 * 128);
  // Entry 0 is transparent: always zero.
  assert.deepEqual(out.data.slice(0, 2), [0, 0]);
  // Palette entries come out in VERA's order: GGGGBBBB, then 0000RRRR.
  const entry = (i) => ({ gb: out.data[i * 2], r: out.data[i * 2 + 1] });
  const colorOf = (index) => {
    const e = entry(index);
    return [e.r * 17, (e.gb >> 4) * 17, (e.gb & 15) * 17];
  };
  // Row 0 of frame 0: the first byte is [white, red] — white on the left,
  // so in the high nibble.
  const first = out.data[32];
  assert.deepEqual(colorOf(first >> 4), WHITE);
  assert.deepEqual(colorOf(first & 15), RED);
  // The last byte of frame 0 is [blue, magenta].
  const last = out.data[32 + 127];
  assert.deepEqual(colorOf(last >> 4), BLUE);
  assert.deepEqual(colorOf(last & 15), MAGENTA);
  // Frame 1 starts one frame (128 bytes) on, in the same palette.
  assert.deepEqual(colorOf(out.data[32 + 128] >> 4), GREEN);
});

test('a picture is padded up to the next legal sprite size, and the padding is transparent', () => {
  const rgba = picture(20, 12, () => ORANGE);
  const out = lower({ name: 'big' }, [{ rgba, width: 20, height: 12 }]);
  assert.equal(out.width, 32);
  assert.equal(out.height, 16);
  assert.equal(out.data.length, 32 + 32 * 16 / 2);
  const row = (y) => out.data.slice(32 + y * 16, 32 + (y + 1) * 16);
  // 20 pixels = ten full bytes of color 1, then transparent.
  assert.deepEqual(row(0).slice(0, 10), new Array(10).fill(0x11));
  assert.deepEqual(row(0).slice(10), new Array(6).fill(0));
  // Rows 12..15 are all padding.
  assert.deepEqual(row(12), new Array(16).fill(0));
});

test('more than fifteen colours is 8BS2110, and the nearest kept color is used', () => {
  const rgba = picture(8, 8, (x, y) => [x * 32, y * 32, 0]);
  const out = lower({ name: 'wash' }, [{ rgba, width: 8, height: 8 }]);
  assert.ok(out.diagnostics.some((d) => d.code === '8BS2110'));
  for (let i = 32; i < out.data.length; i += 1) {
    assert.ok((out.data[i] >> 4) <= 15 && (out.data[i] & 15) <= 15);
    assert.ok(out.data[i] !== 0, 'every pixel is opaque, so none may land on the transparent index');
  }
});

test('frames that do not fit the sprite\'s 4096-byte window are cut and say so', () => {
  const sheet = picture(64, 64, () => RED);
  const frame = { rgba: sheet, width: 64, height: 64 };
  const out = lower({ name: 'huge', animations: [{ frames: [0, 0, 0], every: 8 }] }, [frame]);
  assert.equal(out.width, 64);
  assert.equal(out.frames, 2);
  assert.ok(out.diagnostics.some((d) => d.code === '8BS2111' && /do not fit/.test(d.message)));
});

function runCli(args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: ROOT, env: { ...process.env, EIGHTBITSCRIPT_CHECKOUT: CHECKOUT }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: String(err) }); });
  });
}

// The probe lives in a scratch directory inside this package so the
// toolchain resolves @8bitscript/* the way it does for the other probes.
function writeProject(dir, { raster = false } = {}) {
  const sheet = tagSheet();
  writeFileSync(join(dir, 'tag.png'), encodePng(32, 16, sheet));
  writeFileSync(join(dir, 'bar.png'), encodePng(32, 8, picture(32, 8, (x) => (x < 16 ? MAGENTA : CYAN))));
  writeFileSync(join(dir, 'big.png'), encodePng(20, 12, picture(20, 12, () => ORANGE)));
  writeFileSync(join(dir, 'art.8bg'), [
    'sprite tag {', '  source "./tag.png"', '  size 16x16', '  transparent auto',
    '  animation flip {', '    frames 0, 1', '    every 4', '  }', '}',
    'sprite bar {', '  source "./bar.png"', '  size 32x8', '  transparent auto', '}',
    'sprite big {', '  source "./big.png"', '  size 20x12', '  transparent auto', '}',
    '',
  ].join('\n'));
  writeFileSync(join(dir, 'probe.8bs'), [
    'import { graphics } from "@8bitscript/graphics";',
    'import { screen } from "@8bitscript/screen";',
    'import { text } from "@8bitscript/text";',
    ...(raster ? ['import { raster, Slot } from "@8bitscript/raster";'] : []),
    'import { tag, bar, big } from "./art.8bg";',
    '',
    'export function main(): void {',
    '    screen.blank();',
    '    text.print(0, "GFX");',
    ...(raster ? [
      '    raster.clear();',
      '    raster.at(100, Slot.BORDER, 2);',
      '    raster.at(200, Slot.BORDER, 0);',
      '    raster.enable();',
    ] : []),
    '    graphics.place(tag, 40, 40);',
    '    graphics.place(bar, 576, 440);',
    '    graphics.place(big, 100, 100);',
    '    while (true) {',
    '        waitFrame();',
    '        graphics.update();',
    '    }',
    '}',
    '',
  ].join('\n'));
}

// The picture's top-left is PNG pixel (16, 16): screen.8bs insets the
// display, VERA sprite coordinates count from the active area, and the
// driver adds back the one line a sprite sits above the layers.
const INSET = 16;
const at = (png, x, y) => pixelAt(png, INSET + x, INSET + y);

async function shoot(dir, frames, name) {
  const shot = join(dir, name);
  const { code, stdout, stderr } = await runCli(['run', 'cx16', '--screenshot', shot, '--frames', String(frames), join(dir, 'probe.8bs')]);
  assert.equal(code, 0, `8bs run cx16 --screenshot failed:\n${stdout}${stderr}`);
  return readFileSync(shot);
}

test('the probe links clean for the X16 with the stock sheet', () => {
  const dir = mkdtempSync(join(HERE, 'gfx-link-'));
  try {
    writeProject(dir);
    const src = readFileSync(join(dir, 'probe.8bs'), 'utf8');
    const { ir, diagnostics } = link(src, join(dir, 'probe.8bs'), { machine: 'cx16', facts: stockFacts('cx16'), checkout: CHECKOUT });
    assert.deepEqual(diagnostics.filter((d) => d.severity !== 'warning'), []);
    assert.ok(diagnostics.some((d) => d.code === '8BS2111' && /VERA hardware sprite/.test(d.message)));
    const names = ir.functions.map((f) => f.name);
    for (const fn of ['graphics_bind', 'graphics_meta', 'graphics_place', 'graphics_update']) assert.ok(names.includes(fn), fn);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'under x16emu, each sprite lands on its pixels, whole, in its own colors, and the animation steps',
  { skip: HAVE_EMULATOR ? false : 'x16emu and ffmpeg are not both on PATH' },
  async () => {
    const dir = mkdtempSync(join(HERE, 'gfx-run-'));
    try {
      writeProject(dir);
      const seenA = new Set();
      for (const frames of [300, 304, 308, 312]) {
        const png = await shoot(dir, frames, `g${frames}.png`);
        // tag at (40, 40): which frame is showing is read at its left half.
        const left = at(png, 44, 50);
        const right = at(png, 52, 50);
        if (JSON.stringify(left) === JSON.stringify(RED) && JSON.stringify(right) === JSON.stringify(BLUE)) seenA.add('a');
        else if (JSON.stringify(left) === JSON.stringify(GREEN) && JSON.stringify(right) === JSON.stringify(YELLOW)) seenA.add('b');
        else assert.fail(`tag at ${frames} frames is neither frame: ${left} | ${right}`);
        if (frames === 300) {
          // Orientation and nibble order, on whichever frame is showing.
          assert.deepEqual(at(png, 39, 40), [0, 0, 0], 'left of the tag is the background');
          assert.deepEqual(at(png, 56, 40), [0, 0, 0], 'right of the tag is the background');
          assert.deepEqual(at(png, 40, 39), [0, 0, 0], 'above the tag is the background');
          assert.deepEqual(at(png, 40, 56), [0, 0, 0], 'below the tag is the background');
          // bar at the bottom-right corner of the active area: left half
          // magenta, right half cyan, 32 × 8.
          assert.deepEqual(at(png, 576, 440), MAGENTA, 'bar, first pixel');
          assert.deepEqual(at(png, 591, 447), MAGENTA, 'bar, left half, last row');
          assert.deepEqual(at(png, 592, 440), CYAN, 'bar, right half, first pixel');
          assert.deepEqual(at(png, 607, 447), CYAN, 'bar, last pixel');
          // big: a 20 × 12 picture in a 32 × 16 sprite, padding transparent.
          assert.deepEqual(at(png, 100, 100), ORANGE, 'big, first pixel');
          assert.deepEqual(at(png, 119, 111), ORANGE, 'big, last picture pixel');
          assert.deepEqual(at(png, 120, 100), [0, 0, 0], 'big, padding to the right');
          assert.deepEqual(at(png, 100, 112), [0, 0, 0], 'big, padding below');
        }
      }
      assert.deepEqual([...seenA].sort(), ['a', 'b'], 'the animation showed both of its frames across four shots');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'under x16emu, sprites and a live raster list share the screen: the border splits and the sprite still shows',
  { skip: HAVE_EMULATOR ? false : 'x16emu and ffmpeg are not both on PATH' },
  async () => {
    const dir = mkdtempSync(join(HERE, 'gfx-raster-'));
    try {
      writeProject(dir, { raster: true });
      const png = await shoot(dir, 300, 'raster.png');
      // BORDER entries: red from picture line 100 to 199, none above and below.
      assert.notDeepEqual(pixelAt(png, 4, INSET + 90), pixelAt(png, 4, INSET + 110), 'the border changed at line 100');
      assert.deepEqual(at(png, 100, 100), ORANGE, 'big is still whole beside the split');
      assert.deepEqual(at(png, 576, 440), MAGENTA, 'bar is still whole');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
