// @8bitscript/color on the C64: the flicker-blend list entries land, and
// blend()/update()/stop() do what they say, run for real under x64sc —
// the same probe-and-screenshot pattern packages/c64/test/layers.test.mjs
// already uses for the raster list itself.
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
const CHECKOUT = join(ROOT, '..', '..');

test('the color probe links clean for the C64, with blend/update/stop in the IR', () => {
  const path = join(HERE, 'color-probe.8bs');
  const { ir, diagnostics } = link(readFileSync(path, 'utf8'), path, {
    machine: 'c64', facts: stockFacts('c64'), checkout: CHECKOUT,
  });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  assert.ok(names.some((name) => /color_blend/.test(name)), `blend() in the IR: ${names.join(', ')}`);
  assert.ok(names.some((name) => /color_update/.test(name)), 'update() in the IR');
  assert.ok(names.some((name) => /color_stop/.test(name)), 'stop() in the IR');
});

test('#fact(video.colorBlend) is true on the C64 and false on the other four release targets', () => {
  for (const [machine, expected] of [['pet', false], ['vic20', false], ['c64', true], ['cx16', false], ['web', false]]) {
    assert.equal(stockFacts(machine)['video.colorBlend'], expected, machine);
  }
});

// --- Under VICE ---------------------------------------------------------

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
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
  const { code, stdout, stderr } = await runCli(['run', 'c64', '--checkout', CHECKOUT, ...extra, '--screenshot', shot, `test/${probe}`]);
  assert.equal(code, 0, `8bs run c64 ${extra.join(' ')} --screenshot failed:\n${stdout}${stderr}`);
  return readFileSync(shot);
}

// VICE's palette, by which channel dominates (packages/c64/test/layers.test.mjs).
const isRed = ([r, g, b]) => r > g + 40 && r > b + 40;
const isGreen = ([r, g, b]) => g > r + 30 && g > b + 30;
const isBlue = ([r, g, b]) => b > r + 40 && b > g + 40;

test('under VICE, blend() sets the border and background at once, update() flips both, and stop() reverts only the border', { skip: !onPath('x64sc') && 'x64sc not on PATH' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-color-'));
  try {
    // Comfortably past the emulator's autostart (~210 frames, per
    // multiplex.test.mjs): the probe's one update() and one stop() have
    // both already run by frame ~10 of its own loop, and it never calls
    // either again, so the state is the same at 400 as at 4000.
    const png = await shoot(scratch, 'color', 'color-probe.8bs', ['--frames', '400']);
    // x64sc's NTSC screenshot geometry (packages/c64/test/layers.test.mjs):
    // the border column is x = 4, and the playfield starts around x = 200,
    // y = 60 — well inside the picture, away from any text this probe
    // does not print.
    assert.ok(isGreen(pixelAt(png, 4, 60)), `border: blend()'s a (green), reverted by stop() after update() flipped it, got ${pixelAt(png, 4, 60)}`);
    assert.ok(isBlue(pixelAt(png, 200, 60)), `background: update()'s b (blue), never stopped, got ${pixelAt(png, 200, 60)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
