// raster.frame() on the X16, run for real under x16emu: the handler adds one
// each time a pass over the planned lines ends (src/rasterline.8bs, $0408),
// once per video frame however slowly the loop reading it runs.
// raster-frame-probe.8bs checks that against the machine itself — each pass
// of its loop is three real frame boundaries long, seen by polling VERA's
// scanline counter, and raster.frame() must have moved by the same three —
// and leaves the border green when twelve passes agree and red at the first
// that does not. A counter of loop passes, or one that never counts (the
// handler without its `inc`), leaves it red.
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
const PROBE = join(HERE, 'raster-frame-probe.8bs');

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}

function runCli(args, { timeoutMs = 150_000 } = {}) {
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

test('the frame-counter probe links clean for the X16 and reads raster.frame()', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'cx16', facts: stockFacts('cx16') });
  assert.deepEqual(diagnostics, []);
  assert.ok(ir.functions.some((f) => f.name.includes('frame')), 'raster.frame() is linked');
});

test(
  'under x16emu, raster.frame() moves by the frames a pass of the loop really took',
  { skip: onPath('x16emu') && onPath('ffmpeg') ? false : 'x16emu and ffmpeg are not both on PATH' },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-cx16-frame-'));
    try {
      const shot = join(scratch, 'frame.png');
      const { code, stdout, stderr } = await runCli(['run', 'cx16', '--screenshot', shot, '--frames', '600', 'test/raster-frame-probe.8bs']);
      assert.equal(code, 0, `8bs run cx16 --screenshot failed:\n${stdout}${stderr}`);
      const [r, g, b] = pixelAt(readFileSync(shot), 4, 100); // the left border
      assert.ok(!(r > g + 40 && r > b + 40), `a red border: raster.frame() disagreed with the machine's own frame boundaries, got ${[r, g, b]}`);
      assert.ok(g > r + 30 && g > b + 30, `a green border: every pass agreed, got ${[r, g, b]}`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
