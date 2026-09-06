// @8bitscript/c128/vdc80 — text on the 80-column screen. The interesting
// assertions are on the VDC's *own* display, which `8bs run --screenshot`
// does not capture (it takes the VIC-IIe's), so this builds through the
// CLI and then drives x128 by hand for both pictures.
//
// The block fill's count is the thing most worth testing, because the two
// ways it can be wrong fail differently: one byte short per run leaves
// part of the probe's 'Q' pre-fill on screen, while one byte long spills
// into $07D0 — an unused gap where nothing would ever show. So the probe
// leaves a sentinel there and reads back both it and the last cell, and
// reports the verdict as the 40-column border colour.
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
const PROBE = join(HERE, 'vdc80-probe.8bs');
const PRG = join(ROOT, 'dist', 'vdc80-probe-c128-ntsc.prg');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the package exports ./vdc80, and it is not the portable text surface', () => {
  assert.equal(pkg['8bitscript'].exports['./vdc80'], './src/vdc80.8bs');
  assert.equal(pkg['8bitscript'].exports['./text'], './src/text.8bs', 'the portable one is still the VIC-IIe\'s 40 columns');
});

test('the probe links clean for the C128, and the surface is real functions in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'c128', facts: stockFacts('c128') });
  assert.deepEqual(diagnostics, []);
  for (const name of ['vdc80_blank', 'vdc80_print', 'vdc80_printNumber', 'vdc_fill']) {
    assert.ok(ir.functions.some((f) => f.name === name), `${name} is in the IR`);
  }
});

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
const SKIP = (!process.env.LLVM_MOS_HOME && 'LLVM_MOS_HOME not set') || (!onPath('x128') && 'x128 not on PATH');

function spawned(command, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: String(err) }); });
  });
}

// Lit (non-black) pixels in a rectangle of a screenshot, sampled every
// `step` pixels in each direction.
//
// The sampling is not laziness: `pixelAt` re-parses the PNG and inflates
// the whole image on every call, so scanning a region pixel by pixel costs
// one full decode per pixel — reading this screen densely took 90 seconds.
// A step of 4 still lands several samples inside any 8x8 character cell,
// which is all these assertions are asking about.
function litPixels(png, x0, x1, y0, y1, step = 4) {
  let lit = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const [r, g, b] = pixelAt(png, x, y);
      if (r + g + b > 150) lit++;
    }
  }
  return lit;
}

test(
  'the 80-column screen draws, and the block fill ends exactly on the last cell',
  { skip: SKIP },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-c128-vdc80-'));
    try {
      // `build`, not `run --screenshot`: the latter would launch x128 a
      // second time for a picture this test does not use.
      const built = await spawned(process.execPath, [
        CLI_BIN, 'build', '--target', 'c128', 'test/vdc80-probe.8bs',
      ], { timeoutMs: 120_000 });
      assert.equal(built.code, 0, `build failed:\n${built.stdout}${built.stderr}`);
      assert.ok(existsSync(PRG));

      // -warp: this is a fixed-cycle run whose only output is the two
      // screenshots, so there is no reason to spend real seconds on it.
      const vic = join(scratch, 'vic.png');
      const vdc = join(scratch, 'vdc.png');
      await spawned('x128', [
        '-model', 'ntsc', '-autostartprgmode', '1', '-warp', '-limitcycles', '6000000',
        '-autostart', PRG, '-exitscreenshotvicii', vic, '-exitscreenshot', vdc,
      ], { timeoutMs: 120_000 });
      assert.ok(existsSync(vic) && existsSync(vdc), 'x128 wrote both displays');

      // The probe's verdict: a green border means the last cell of the
      // matrix was filled and the byte past it was not.
      const [r, g, b] = pixelAt(readFileSync(vic), 4, 4);
      assert.ok(g > r + 30 && g > b + 30, `the fill ended on the last cell (green border), got rgb(${[r, g, b]})`);

      const shot = readFileSync(vdc);
      // The three rows of text at the top left.
      const rows = litPixels(shot, 100, 420, 18, 52);
      assert.ok(rows > 20, `the 80-column screen shows the printed rows (${rows} lit samples)`);
      // Cell 1999 — the last cell of the last row, written on its own.
      const corner = litPixels(shot, 735, 762, 205, 225, 2);
      assert.ok(corner > 2, `the last cell of the last row is addressable (${corner} lit samples)`);
      // And the middle of the screen is clear: the 'Q' pre-fill is gone,
      // so the blank covered everything between.
      const middle = litPixels(shot, 150, 700, 90, 190, 8);
      assert.equal(middle, 0, `blank() cleared the whole screen (${middle} lit samples)`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
