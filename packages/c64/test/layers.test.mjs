// The C64's hardware layers, run for real under x64sc: the raster list,
// bitmap mode, the region probe, and REU transfers. Each probe program
// links clean for the C64 without an emulator; with x64sc and the SDK
// installed it is run headless and its screenshot read at a few pixels —
// the probe encodes its answer in colours, as test/reu-probe.8bs does.
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
import { pixelAt } from '../../cli/src/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');

const PROBES = {
  raster: ['raster-probe.8bs', ['raster_at', 'raster_enable']],
  bitmap: ['bitmap-probe.8bs', ['bitmap_enter', 'bitmap_plot', 'bitmap_fillColors', 'sprites_setShapeByte']],
  region: ['region-probe.8bs', ['detectRegion', 'sid_detectRegion', 'sid_frequencyOf']],
  reuTransfer: ['reu-transfer-probe.8bs', ['reu_stash', 'reu_fetch', 'reu_swap', 'reu_verify', 'reu_fillReu']],
};

for (const [name, [file, functions]] of Object.entries(PROBES)) {
  test(`the ${name} probe links clean for the C64, with its functions in the IR`, () => {
    const path = join(HERE, file);
    const { ir, diagnostics } = link(readFileSync(path, 'utf8'), path, { machine: 'c64', facts: stockFacts('c64') });
    assert.deepEqual(diagnostics, []);
    const names = ir.functions.map((f) => f.name);
    for (const fn of functions) assert.ok(names.includes(fn), fn);
    assert.equal(ir.nativeSources.length, 1, 'the package\'s raster.s rides along');
  });
}

// --- Under VICE ---------------------------------------------------------

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
const HAS_SDK = Boolean(process.env.LLVM_MOS_HOME);
const skip = (!HAS_SDK && 'LLVM_MOS_HOME not set') || (!onPath('x64sc') && 'x64sc not on PATH');

function runCli(args, { timeoutMs = 90_000 } = {}) {
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

async function shoot(scratch, name, probe, extra = []) {
  const shot = join(scratch, `${name}.png`);
  const { code, stdout, stderr } = await runCli(['run', 'c64', ...extra, '--screenshot', shot, `test/${probe}`]);
  assert.equal(code, 0, `8bs run c64 ${extra.join(' ')} --screenshot failed:\n${stdout}${stderr}`);
  return readFileSync(shot);
}

// VICE's palette, by which channel dominates.
const isRed = ([r, g, b]) => r > g + 40 && r > b + 40;
const isGreen = ([r, g, b]) => g > r + 30 && g > b + 30;
const isBlue = ([r, g, b]) => b > r + 40 && b > g + 40;
const isYellow = ([r, g, b]) => r > 200 && g > 200 && b < 200;
const isWhite = ([r, g, b]) => r > 200 && g > 200 && b > 200;

test('under VICE, the raster list changes the border colour at its lines, top to bottom', { skip }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    const png = await shoot(scratch, 'raster', 'raster-probe.8bs');
    // x64sc's NTSC screenshot is 384 x 247, the border column at x = 4, and
    // raster line L at about y = L - 20 in it (measured: the first text
    // row, lines 51-58, is at y 31). The bands: blue, red from line 100,
    // green from 150, yellow from 200, blue from 240.
    assert.ok(isBlue(pixelAt(png, 4, 30)), `line ~50: blue, got ${pixelAt(png, 4, 30)}`);
    assert.ok(isRed(pixelAt(png, 4, 105)), `line ~125: red, got ${pixelAt(png, 4, 105)}`);
    assert.ok(isGreen(pixelAt(png, 4, 155)), `line ~175: green, got ${pixelAt(png, 4, 155)}`);
    assert.ok(isYellow(pixelAt(png, 4, 205)), `line ~225: yellow, got ${pixelAt(png, 4, 205)}`);
    assert.ok(isBlue(pixelAt(png, 4, 235)), `line ~255: blue, got ${pixelAt(png, 4, 235)}`);
    // The background inside the picture: green when $FFFA/$FFFB and
    // $FFFE/$FFFF held the same non-zero vector before enable().
    assert.ok(isGreen(pixelAt(png, 200, 60)), `the .init vectors: a green background, got ${pixelAt(png, 200, 60)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, bitmap mode draws a plotted rectangle on coloured cells and a sprite from a block under the I/O area', { skip }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    const png = await shoot(scratch, 'bitmap', 'bitmap-probe.8bs');
    // The picture's pixel (px, py) is at (32 + px, 31 + py) in the
    // screenshot; a sprite at VIC (X, Y) has its top-left at picture
    // (X - 24, Y - 50).
    const at = (px, py) => pixelAt(png, 32 + px, 31 + py);
    assert.ok(isWhite(at(80, 70)), `inside the rectangle: white, got ${at(80, 70)}`);
    assert.ok(isBlue(at(200, 70)), `outside it: blue cells, got ${at(200, 70)}`);
    assert.ok(isYellow(at(250 - 24 + 12, 180 - 50 + 10)), `the sprite: yellow, got ${at(238, 140)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, detectRegion says NTSC under -model ntsc and PAL under -model c64', { skip }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    const ntsc = await shoot(scratch, 'ntsc', 'region-probe.8bs');
    assert.ok(isYellow(pixelAt(ntsc, 4, 4)), `NTSC: a yellow border, got ${pixelAt(ntsc, 4, 4)}`);
    const pal = await shoot(scratch, 'pal', 'region-probe.8bs', ['--pal']);
    assert.ok(isGreen(pixelAt(pal, 4, 4)), `PAL: a green border, got ${pixelAt(pal, 4, 4)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, REU transfers round-trip the screen through a 512 KiB unit, and a stock C64 tries none', { skip }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    const reu = await shoot(scratch, 'reu512', 'reu-transfer-probe.8bs', ['--hardware', 'ram=reu512']);
    assert.ok(isGreen(pixelAt(reu, 4, 4)), `512 KiB: a green border, got ${pixelAt(reu, 4, 4)}`);
    const none = await shoot(scratch, 'none', 'reu-transfer-probe.8bs');
    assert.ok(isRed(pixelAt(none, 4, 4)), `no REU: a red border, got ${pixelAt(none, 4, 4)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
