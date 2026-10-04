// raster.frame() on the C64, run for real under x64sc: the handler adds one
// at line 0 of every video frame (native/6502/raster.s, $06C3), so the count
// advances once per frame however slowly the loop reading it runs.
// raster-frame-probe.8bs checks that against the machine itself — each pass
// of its loop is three real frame boundaries long, seen by polling the VIC's
// raster counter, and raster.frame() must have moved by the same three — and
// paints the playfield green when twelve passes agree and red at the first
// that does not. A counter of loop passes (one per pass) or one that never
// counts (the handler without its `inc`) paints it red.
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
const CHECKOUT = join(ROOT, '..', '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');

const emulatorInstalled = () => (process.env.PATH ?? '').split(delimiter).some((d) => existsSync(join(d, 'x64sc')));

const isRed = ([r, g, b]) => r > g + 40 && r > b + 40;
const isGreen = ([r, g, b]) => g > r + 30 && g > b + 30;

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('the frame-counter probe links clean for the C64 and reads raster.frame()', () => {
  const path = join(HERE, 'raster-frame-probe.8bs');
  const { ir, diagnostics } = link(readFileSync(path, 'utf8'), path, { machine: 'c64', facts: stockFacts('c64'), checkout: CHECKOUT });
  assert.deepEqual(diagnostics, []);
  assert.ok(ir.functions.some((f) => f.name.includes('frame')), 'raster.frame() is linked');
});

test('under VICE, raster.frame() moves by the frames a pass of the loop really took', { skip: !emulatorInstalled() && 'x64sc is not installed' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-frame-'));
  try {
    const shot = join(scratch, 'frame.png');
    const { code, stdout, stderr } = await runCli(['run', 'c64', '--checkout', CHECKOUT, '--screenshot', shot, 'test/raster-frame-probe.8bs']);
    assert.equal(code, 0, `8bs run c64 --screenshot failed:\n${stdout}${stderr}`);
    const png = readFileSync(shot);
    const pixel = pixelAt(png, 200, 60); // inside the picture: the playfield colour
    assert.ok(!isRed(pixel), `a red playfield: raster.frame() disagreed with the machine's own frame boundaries, got ${pixel}`);
    assert.ok(isGreen(pixel), `a green playfield: every pass agreed, got ${pixel}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
