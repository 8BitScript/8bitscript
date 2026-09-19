// @8bitscript/timeline — pure, so the strongest check is arithmetic: the
// probe counts what each predicate says over 300 frames and prints the
// counts over a literal of what they must be; under xpet the two rows are
// compared pixel for pixel (identical cells render identical pixels — no
// glyph reading needed). Weaker layers first: the manifest, and the probe
// linking clean for all nine machines with every predicate in the IR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';
import { pixelAt } from '../../cli/src/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');
const PROBE = join(HERE, 'cues-probe.8bs');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const MACHINES = ['c64', 'vic20', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];

test('the manifest names one entry and no machine twins: the same code everywhere', () => {
  assert.equal(pkg['8bitscript'].entry, './src/index.8bs');
  assert.ok(existsSync(join(ROOT, 'src', 'index.8bs')));
  assert.equal(pkg.dependencies, undefined, 'pure: nothing of any machine');
});

for (const machine of MACHINES) {
  test(`the cues probe links clean for ${machine}, every predicate a real function in the IR`, () => {
    const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine, facts: stockFacts(machine) });
    assert.deepEqual(diagnostics, []);
    const names = ir.functions.map((f) => f.name);
    for (const fn of ['timeline_start', 'timeline_tick', 'timeline_frame', 'timeline_at', 'timeline_after', 'timeline_between', 'timeline_every']) {
      assert.ok(names.includes(fn), `${machine}: ${fn}`);
    }
  });
}

// The probe's arithmetic, mirrored: tick() runs before the checks, so
// frame 0 is never seen and the counts are over frames 1..299.
test('the literal the probe prints is what its predicates count over 300 frames', () => {
  let hits120 = 0, after200 = 0, eights = 0, inBand = 0;
  for (let frame = 1; frame <= 300; frame++) {
    if (frame === 120) hits120++;
    if (frame >= 200 && frame < 300) after200++;
    if ((frame & 0xff) % 8 === 0 && frame < 300) eights++;
    if (frame >= 50 && frame < 60) inBand++;
  }
  const literal = `AT120 ${String(hits120).padStart(3, '0')} AFTER ${String(after200).padStart(3, '0')} EIGHTS ${String(eights).padStart(3, '0')} BAND ${String(inBand).padStart(3, '0')}`;
  assert.equal(literal, 'AT120 001 AFTER 100 EIGHTS 037 BAND 010');
  assert.match(readFileSync(PROBE, 'utf8'), new RegExp(`text\\.print\\(80, "${literal}"\\)`), 'the probe prints this literal on row 2');
});

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

test('under xpet, at frame 300 the counted row matches the literal row pixel for pixel', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-timeline-'));
  try {
    const shot = join(scratch, 'cues.png');
    const { code, stdout, stderr } = await runCli(['run', 'pet', '--frames', '600', '--screenshot', shot, 'test/cues-probe.8bs']);
    assert.equal(code, 0, `8bs run pet --screenshot failed:\n${stdout}${stderr}`);
    const png = readFileSync(shot);
    // PET cell (0, 0) at PNG (32, 8), 8 x 8 (packages/pet/test/blocks.test.mjs).
    // Row 1 is the counted line, row 2 the literal; 39 cells each.
    let lit = 0;
    for (let x = 32; x < 32 + 39 * 8; x++) {
      for (let dy = 0; dy < 8; dy++) {
        const counted = pixelAt(png, x, 16 + dy);
        const literal = pixelAt(png, x, 24 + dy);
        assert.deepEqual(counted, literal, `pixel (${x}, ${16 + dy}) differs from the literal row`);
        if (counted[0] + counted[1] + counted[2] > 150) lit++;
      }
    }
    assert.ok(lit > 300, `the rows are not blank (${lit} lit pixels)`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
