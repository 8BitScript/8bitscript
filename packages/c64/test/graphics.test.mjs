// @8bitscript/graphics on the C64, end to end: a .8bg compiled to VIC-II
// sprite blocks by this package's media module (media/index.cjs), played by
// packages/graphics/src/index.c64.8bs through @8bitscript/sprites'
// multiplexer. test/graphics-probe.8bs places fifteen graphics sprites, so
// the link test runs anywhere and the screenshot test (x64sc, headless)
// reads the picture back: where each sprite landed, which colour the PNG
// became, that a 9th X bit survives, and that the animation advanced.
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
// packages/c64 has no node_modules of its own, so @8bitscript/graphics and
// @8bitscript/sprites resolve through this checkout.
const CHECKOUT = join(ROOT, '..', '..');
const PROBE = join(HERE, 'graphics-probe.8bs');

test('the graphics probe links for the C64: fifteen .8bg sprites bound into VIC-II shape blocks', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, {
    machine: 'c64', facts: stockFacts('c64'), checkout: CHECKOUT,
  });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const fn of ['graphics_bind', 'graphics_meta', 'graphics_place', 'graphics_update', 'multiplex_update']) {
    assert.ok(names.includes(fn), `${fn} is linked: ${names.join(', ')}`);
  }
  const binds = names.filter((name) => name.startsWith('__8bs_media_bind_'));
  assert.equal(binds.length, 15, 'one bind per sprite in graphics-probe.8bg');
});

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

// x64sc's NTSC screenshot is 384 x 247; sprite coordinate (X, Y) lands at
// screenshot pixel (X + 8, Y - 27) (measured: a sprite at (24, 50), the
// playfield's top-left, has its first pixel at (32, 23)).
const WIDTH = 384;
const HEIGHT = 247;
const SPRITE_X = 8;
const SPRITE_Y = -27;
const ORIGIN_X = 24;
const ORIGIN_Y = 50;

// VICE's palette, by which channel dominates (the same classifiers the
// layers test uses, plus the two this probe adds).
const classes = {
  yellow: ([r, g, b]) => r > 200 && g > 200 && b < 180,
  white: ([r, g, b]) => r > 230 && g > 230 && b > 230,
  cyan: ([r, g, b]) => r < 170 && g > 200 && b > 150,
  red: ([r, g, b]) => r > 150 && g < 100 && b < 130,
  green: ([r, g, b]) => g > r + 30 && g > b + 50 && g < 220,
};

/** The pixels of the screenshot in each colour class: count and bounding box. */
function survey(file) {
  // Decoded once: cli/src/png.mjs's pixelAt decodes the whole file per call.
  const { width, height, rgba } = decodePng(file);
  assert.deepEqual([width, height], [WIDTH, HEIGHT], 'x64sc\'s NTSC screenshot size');
  const found = Object.fromEntries(Object.keys(classes).map((name) => [name, { n: 0, x0: WIDTH, x1: -1, y0: HEIGHT, y1: -1 }]));
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const o = (y * WIDTH + x) * 4;
      const pixel = [rgba[o], rgba[o + 1], rgba[o + 2]];
      for (const [name, matches] of Object.entries(classes)) {
        if (!matches(pixel)) continue;
        const box = found[name];
        box.n += 1;
        box.x0 = Math.min(box.x0, x);
        box.x1 = Math.max(box.x1, x);
        box.y0 = Math.min(box.y0, y);
        box.y1 = Math.max(box.y1, y);
        break;
      }
    }
  }
  return found;
}

test('under VICE, fifteen graphics sprites land where they were placed, in the PNGs\' colours, with the 9th X bit and the animation intact', async (t) => {
  if (!onPath('x64sc')) {
    t.skip('x64sc not on PATH');
    return;
  }
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-graphics-'));
  try {
    const shot = join(scratch, 'graphics.png');
    const { code, stdout, stderr } = await runCli([
      'run', 'c64', '--checkout', CHECKOUT, '--screenshot', shot, '--frames', '400', 'test/graphics-probe.8bs',
    ]);
    assert.equal(code, 0, `8bs run c64 --screenshot failed:\n${stdout}${stderr}`);
    const seen = survey(readFileSync(shot));

    // corner: an 8x8 yellow square at the playfield's top-left corner.
    assert.deepEqual(seen.yellow, {
      n: 64, x0: ORIGIN_X + SPRITE_X, x1: ORIGIN_X + SPRITE_X + 7, y0: ORIGIN_Y + SPRITE_Y, y1: ORIGIN_Y + SPRITE_Y + 7,
    }, 'the corner sprite sits on the first pixel of the playfield');

    // walker: twelve updates at `every 2` is six frame advances, so frame
    // 2 of 4 (6 mod 4) is showing: a 4-wide, 16-high bar at x offset 8..11.
    const walkerX = ORIGIN_X + 40;
    const walkerY = ORIGIN_Y + 20;
    assert.deepEqual(seen.white, {
      n: 4 * 16, x0: walkerX + SPRITE_X + 8, x1: walkerX + SPRITE_X + 11, y0: walkerY + SPRITE_Y, y1: walkerY + SPRITE_Y + 15,
    }, 'the walker animated to frame 2: its bar moved from x offset 0 to 8');

    // wide: a whole 24x21 sprite at X = 300 — past 255, the VIC-II's ninth X bit.
    assert.deepEqual(seen.cyan, {
      n: 24 * 21, x0: 300 + SPRITE_X, x1: 300 + SPRITE_X + 23, y0: ORIGIN_Y + 60 + SPRITE_Y, y1: ORIGIN_Y + 60 + SPRITE_Y + 20,
    }, 'the wide sprite is whole, with X = 300 intact');

    // twelve 8x8 dots, alternating red and green, one per 8 lines down and
    // 20 pixels across: more sprites than the VIC has hardware for. The
    // last (green) is at X = 260, past 255.
    assert.equal(seen.red.n, 6 * 64, 'six red dots, whole');
    assert.equal(seen.green.n, 6 * 64, 'six green dots, whole');
    assert.equal(seen.red.x0, ORIGIN_X + 16 + SPRITE_X, 'the first dot is at its X');
    assert.equal(seen.red.y0, ORIGIN_Y + 90 + SPRITE_Y, 'the first dot is at its Y');
    assert.equal(seen.green.x1, 260 + SPRITE_X + 7, 'the last dot reached X = 260');
    assert.equal(seen.green.y1, ORIGIN_Y + 178 + SPRITE_Y + 7, 'the last dot reached its Y, the 12th sprite on a 15-sprite screen');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
