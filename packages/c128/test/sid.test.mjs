// @8bitscript/c128/sid — the SID as the C128 has it.
//
// A sound chip is awkward to test from a screenshot, so the probe asks the
// chip the only two questions it answers — voice 3's oscillator and its
// envelope — and reports the answers as colours. The other half of this
// file needs no emulator: the note tables are arithmetic, and arithmetic
// can be checked against the formula it came from.
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
const PROBE = join(HERE, 'sid-probe.8bs');
const SOURCE = join(ROOT, 'src', 'sid.8bs');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the package exports ./sid', () => {
  assert.equal(pkg['8bitscript'].exports['./sid'], './src/sid.8bs');
});

test('the probe links clean for the C128, and the surface is real functions in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'c128', facts: stockFacts('c128') });
  assert.deepEqual(diagnostics, []);
  for (const name of ['sid_play', 'sid_setEnvelope', 'sid_setWaveform', 'sid_reset', 'sid_detectRegion']) {
    assert.ok(ir.functions.some((f) => f.name === name), `${name} is in the IR`);
  }
});

// The tables were carried over from the C64 package, which is only correct
// because the two machines run the same clocks. This checks them against
// the formula rather than against that assumption: a voice's frequency
// register is Fn = f * 2^24 / clock, and equal temperament puts note n at
// 440 * 2^((n - 57) / 12) Hz with A4 = 57.
test('every note in both tables is the frequency register for its pitch at that machine\'s clock', () => {
  const source = readFileSync(SOURCE, 'utf8');
  const table = (name) => {
    const match = new RegExp(`const ${name}: array<usmallint, 84> = \\[([^\\]]*)\\]`).exec(source);
    assert.ok(match, `${name} is in the source`);
    const values = match[1].replace(/\/\/[^\n]*/g, '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
    assert.equal(values.length, 84, `${name} has 84 entries`);
    return values;
  };
  for (const [name, clock] of [['NOTE_PAL', 985248], ['NOTE_NTSC', 1022727]]) {
    const values = table(name);
    for (let note = 0; note < 84; note += 1) {
      const hertz = 440 * 2 ** ((note - 57) / 12);
      const expected = Math.round((hertz * 2 ** 24) / clock);
      assert.equal(values[note], expected, `${name}[${note}]`);
      assert.ok(values[note] <= 0xFFFF, `${name}[${note}] fits the 16-bit register`);
    }
  }
});

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
const NATIVE_BACKEND_PENDING = 'Bare Metal: waiting on the native backend';

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

test(
  'under x128 the chip answers: voice 3 runs, its envelope rises, and the region comes from the KERNAL\'s own flag',
  { skip: NATIVE_BACKEND_PENDING },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-c128-sid-'));
    try {
      for (const [name, region] of [['ntsc', []], ['pal', ['--pal']]]) {
        const shot = join(scratch, `${name}.png`);
        const { code, stdout, stderr } = await runCli(
          ['run', 'c128', ...region, '--screenshot', shot, 'test/sid-probe.8bs'],
          { timeoutMs: 90_000 },
        );
        assert.equal(code, 0, `8bs run c128 ${region.join(' ')} failed:\n${stdout}${stderr}`);
        const png = readFileSync(shot);

        // Green border: voice 3's noise oscillator read differently on
        // different frames, and its envelope was above zero after the
        // gate. The chip is clocked and the writes landed.
        const [r, g, b] = pixelAt(png, 4, 4);
        assert.ok(g > r + 30 && g > b + 30, `${name}: the SID answered (green border), got rgb(${[r, g, b]})`);

        // The background is the region sid.detectRegion() found in $0A03:
        // black for NTSC, blue for PAL. Getting this wrong would play
        // every note 3.8 percent out.
        const [br, bg, bb] = pixelAt(png, 180, 150);
        if (name === 'ntsc') {
          assert.ok(br < 60 && bg < 60 && bb < 60, `ntsc: a black background, got rgb(${[br, bg, bb]})`);
        } else {
          assert.ok(bb > br + 30 && bb > bg + 30, `pal: a blue background, got rgb(${[br, bg, bb]})`);
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
