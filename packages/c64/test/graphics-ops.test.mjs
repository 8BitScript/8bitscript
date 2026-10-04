// Every @8bitscript/graphics operation on the C64, under x64sc, read back by
// pixel: hide then place, setFrame (clamped), animate off and on, color (on a
// sprite the multiplexer reuses too), the playfield's edges, the eight-per-line
// limit, and a portable raster list built in the same frame as the sprites.
// The probes are graphics-ops-probe.8bs, graphics-line-probe.8bs and
// graphics-raster-probe.8bs; the link tests run anywhere (and in CI, through
// packages/graphics/test/c64-ops.test.mjs), the screenshot tests skip
// without x64sc on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';
import { decodePng } from '../../graphics-tools/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');
const CHECKOUT = join(ROOT, '..', '..');

const OPS = join(HERE, 'graphics-ops-probe.8bs');
const LINE = join(HERE, 'graphics-line-probe.8bs');
const RASTER = join(HERE, 'graphics-raster-probe.8bs');
const WRAP = join(HERE, 'graphics-wrap-probe.8bs');

for (const [probe, calls] of [
  [OPS, ['graphics_place', 'graphics_hide', 'graphics_setFrame', 'graphics_animate', 'graphics_color', 'graphics_update']],
  [LINE, ['graphics_place', 'graphics_update']],
  [RASTER, ['graphics_place', 'multiplex_update']],
  [WRAP, ['graphics_place', 'graphics_update']],
]) {
  test(`${probe.split('/').pop()} links for the C64`, () => {
    const { ir, diagnostics } = link(readFileSync(probe, 'utf8'), probe, {
      machine: 'c64', facts: stockFacts('c64'), checkout: CHECKOUT,
    });
    assert.deepEqual(diagnostics, []);
    const names = ir.functions.map((f) => f.name);
    for (const fn of calls) assert.ok(names.includes(fn), `${fn} is linked: ${names.join(', ')}`);
  });
}

// --- Under VICE ---------------------------------------------------------

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}

function runCli(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: String(err) }); });
  });
}

// x64sc's NTSC screenshot is 384 x 247. A stage pixel (x, y) is at screenshot
// pixel (x + 32, y + 23): the sprite chip's X is the stage x + 24 and its
// picture column is + 8; its Y is the stage y + 50 and the row is - 27
// (measured, graphics.test.mjs).
const WIDTH = 384;
const HEIGHT = 247;
const sx = (x) => x + 32;
const sy = (y) => y + 23;

// VICE's colours, measured on a capture; a sprite pixel is the colour or it is
// not a sprite pixel (the screen is black everywhere else in these probes,
// border included).
const PALETTE = {
  cyan: [138, 230, 203],
  red: [169, 71, 100],
  green: [114, 189, 103],
  white: [255, 255, 255],
  purple: [154, 88, 185],
  lightBlue: [98, 145, 251],
  yellow: [255, 248, 141],
};

function classify([r, g, b]) {
  for (const [name, [pr, pg, pb]] of Object.entries(PALETTE)) {
    if (Math.abs(r - pr) < 12 && Math.abs(g - pg) < 12 && Math.abs(b - pb) < 12) return name;
  }
  return null;
}

/** Every non-black pixel of a capture, by colour name; `count(name, x0, x1, y0, y1)` counts a window. */
function survey(file) {
  const { width, height, rgba } = decodePng(file);
  assert.deepEqual([width, height], [WIDTH, HEIGHT], 'x64sc\'s NTSC screenshot size');
  const pixels = Object.fromEntries(Object.keys(PALETTE).map((name) => [name, []]));
  const unknown = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const o = (y * WIDTH + x) * 4;
      const rgb = [rgba[o], rgba[o + 1], rgba[o + 2]];
      if (rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0) continue;
      const name = classify(rgb);
      if (name) pixels[name].push([x, y]);
      else unknown.push([x, y, rgb]);
    }
  }
  const count = (name, x0 = 0, x1 = WIDTH - 1, y0 = 0, y1 = HEIGHT - 1) =>
    pixels[name].filter(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1).length;
  return { pixels, unknown, count, total: (name) => pixels[name].length };
}

async function shoot(probe, frames, name) {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-graphics-ops-'));
  try {
    const shot = join(scratch, name);
    const { code, stdout, stderr } = await runCli([
      'run', 'c64', '--checkout', CHECKOUT, '--screenshot', shot, '--frames', String(frames), probe,
    ]);
    assert.equal(code, 0, `8bs run c64 --screenshot failed:\n${stdout}${stderr}`);
    return survey(readFileSync(shot));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test('under VICE, every operation shows on the C64: hide and place, setFrame clamped, animate off and on, color on reused sprites, the edges', async (t) => {
  if (!onPath('x64sc')) {
    t.skip('x64sc not on PATH');
    return;
  }
  const seen = await shoot(OPS, 400, 'ops.png');
  assert.deepEqual(seen.unknown, [], 'every non-black pixel is one of the probe\'s colours');

  // stepper: setFrame(9) clamps to the last of 4 frames, whose bar is at
  // offset 12..15; animate(false) then holds it through sixteen updates.
  assert.equal(seen.count('white', sx(40) + 12, sx(40) + 15, sy(20), sy(20) + 15), 64, 'stepper is on frame 3 (4 wide, 16 high)');
  assert.equal(seen.count('white', sx(40), sx(40) + 23, sy(20), sy(20) + 20), 64, 'and nothing else of it');
  // runner: paused for four updates, then twelve at `every 2` are six
  // steps, so frame 2 (bar at offset 8..11).
  assert.equal(seen.count('white', sx(100) + 8, sx(100) + 11, sy(20), sy(20) + 15), 64, 'runner is on frame 2 after pause and resume');
  assert.equal(seen.count('white', sx(100), sx(100) + 23, sy(20), sy(20) + 20), 64, 'and nothing else of it');
  assert.equal(seen.total('white'), 128);

  // hide then place: the marker is where it was placed last and nowhere else.
  assert.equal(seen.count('yellow', sx(60), sx(60) + 7, sy(150), sy(150) + 7), 64, 'mover is whole at its second position');
  assert.equal(seen.total('yellow'), 64, 'and not at (0, 0), where it was first placed');
  // hidden and never placed again: absent (the other five red dots are the staircase's).
  assert.equal(seen.count('red', sx(250), sx(257), sy(150), sy(157)), 0, 'gone stays hidden');
  assert.equal(seen.total('red'), 5 * 64, 'the staircase\'s five red dots, whole');
  // the staircase's unchanged greens: s1, s3, s7 (s5 and s9 are recoloured).
  assert.equal(seen.total('green'), 3 * 64, 'three green dots left');

  // color: recol is purple, s5 light blue and s9 purple, each whole and each
  // only itself — s9 is a sprite the multiplexer reuses.
  assert.equal(seen.count('purple', sx(260), sx(267), sy(40), sy(47)), 64, 'recol is purple');
  assert.equal(seen.count('purple', sx(196), sx(203), sy(162), sy(169)), 64, 'the reused s9 is purple');
  assert.equal(seen.total('purple'), 128);
  assert.equal(seen.count('lightBlue', sx(116), sx(123), sy(130), sy(137)), 64, 's5 is light blue');
  assert.equal(seen.total('lightBlue'), 64);

  // edges: 24 columns at stage x = 300 leave 20 in the playfield; 10 of 21
  // rows at y = 190 are above the bottom border; a sprite that starts below
  // the picture, past the right edge, or at a 16-bit y that wraps when the
  // origin is added is not drawn anywhere.
  assert.equal(seen.count('cyan', sx(300), WIDTH - 1, sy(60), sy(60) + 20), 20 * 21, 'edgeRight shows 20 of its 24 columns');
  assert.equal(seen.count('cyan', sx(120), sx(120) + 23, sy(190), HEIGHT - 1), 24 * 10, 'edgeBottom shows 10 of its 21 rows');
  assert.equal(seen.total('cyan'), 20 * 21 + 24 * 10, 'edgeBelow (y = 210), edgeFar (x = 500: chip X 524 wraps the 9-bit register) and edgeHuge (y = 65500) are not drawn');
});

test('under VICE, a y that wraps 16 bits when the playfield\'s offset is added draws nothing, even with the vertical border open', async (t) => {
  if (!onPath('x64sc')) {
    t.skip('x64sc not on PATH');
    return;
  }
  // graphics-wrap-probe.8bs: sprites.extend(true), a marker at (100, 100) and
  // a 24x21 sprite at y = 65500. Without the guard in graphics.place the
  // second is chip y 14 and draws 8 rows in the opened top border (seen:
  // 192 cyan pixels at the top of the capture).
  const seen = await shoot(WRAP, 400, 'wrap.png');
  assert.deepEqual(seen.unknown, []);
  assert.equal(seen.count('yellow', sx(100), sx(100) + 7, sy(100), sy(100) + 7), 64, 'the marker draws, so the open-border build shows sprites');
  assert.equal(seen.total('yellow'), 64);
  assert.equal(seen.total('cyan'), 0, 'the sprite at y = 65500 is not drawn anywhere');
});

test('under VICE, eight sprites show on one raster line and the first eight in slot order are the ones, with no flicker', async (t) => {
  if (!onPath('x64sc')) {
    t.skip('x64sc not on PATH');
    return;
  }
  // d0..d11 are placed right to left, 26 pixels apart, on y = 100.
  for (const frames of [300, 340]) {
    const seen = await shoot(LINE, frames, `line-${frames}.png`);
    assert.deepEqual(seen.unknown, []);
    assert.equal(seen.total('green'), 8 * 64, `eight whole dots at --frames ${frames}`);
    for (let k = 0; k < 12; k += 1) {
      const x = 290 - 26 * k;
      const shown = seen.count('green', sx(x), sx(x) + 7, sy(100), sy(100) + 7);
      assert.equal(shown, k < 8 ? 64 : 0, `d${k} (x = ${x}) is ${k < 8 ? 'drawn' : 'dropped'} at --frames ${frames}`);
    }
  }
});

test('under VICE, a portable raster list built in the same frame as twelve multiplexed sprites keeps both', async (t) => {
  if (!onPath('x64sc')) {
    t.skip('x64sc not on PATH');
    return;
  }
  const seen = await shoot(RASTER, 400, 'raster.png');
  assert.deepEqual(seen.unknown, []);
  // Border yellow from capture row 123 (the entry at picture line 100 is
  // raster line 150 and shows from the line after it) through row 172, black
  // from row 174 on and above row 123; row 173 is where the entry at picture
  // line 150 lands and is not asserted. The left border is 32 pixels wide.
  for (const row of [sy(100), sy(100) + 25, sy(149)]) {
    assert.equal(seen.count('yellow', 0, 31, row, row), 32, `row ${row}: the left border is yellow`);
  }
  assert.equal(seen.count('yellow', 0, 31, sy(100) - 1, sy(100) - 1), 0, 'black the line above the band');
  assert.equal(seen.count('yellow', 0, 31, sy(150) + 1, sy(150) + 1), 0, 'black the line below it');
  assert.equal(seen.count('yellow', 0, WIDTH - 1, 0, sy(100) - 1), 0, 'black all the way to the top');
  assert.equal(seen.count('yellow', 0, WIDTH - 1, sy(150) + 1, HEIGHT - 1), 0, 'and all the way to the bottom');
  // And the sprites, all twelve whole: six red, six green, the last at x = 236.
  assert.equal(seen.total('red'), 6 * 64);
  assert.equal(seen.total('green'), 6 * 64);
  assert.equal(seen.count('green', sx(236), sx(236) + 7, sy(178), sy(178) + 7), 64, 'the last, reused, dot is at its X');
});
