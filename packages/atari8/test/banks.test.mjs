// @8bitscript/atari8/banks — the probe for a 130XE's extra 64 KiB. Two
// layers: the probe program links clean for the Atari with the stock
// sheet (no emulator needed), and, when atari800 and the SDK are
// installed, it is run on an 800XL and a 130XE and the border colour each
// screenshot shows is what banks.kib() found. The border encodes the
// answer (see banks-probe.8bs) so the test reads one pixel, not text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { loadCatalog, stockFacts } from '../../cli/src/hardware.mjs';
import { pixelAt } from '../../cli/src/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');
const PROBE = join(HERE, 'banks-probe.8bs');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the package exports ./banks, and the 130XE is the value found at run time by it', () => {
  assert.equal(pkg['8bitscript'].exports['./banks'], './src/banks.8bs');
  const { options } = loadCatalog('atari8');
  assert.equal(options.model.values['130xe'].detect, '@8bitscript/atari8/banks');
  assert.equal(options.model.detect, undefined, 'not the whole option: a xegs is a different binary either way');
  assert.equal(options.model.values['800xl'].detect, undefined, 'and an 800XL has nothing to find');
});

test('the probe program links clean for the Atari, and banks.kib() is a real function in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'atari8', facts: stockFacts('atari8') });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const name of ['banks_kib', 'banks_kept', 'banks_markAll', 'banks_select', 'banks_base']) {
    assert.ok(names.includes(name), name);
  }
});

// The probe writes through the window at $4000, which is inside the region
// the linker gives the program. That is only safe while the program's own
// code and data end below $4000 — so this holds the probe build itself to
// the rule its own notes state.
test('the probe build ends well below the $4000 window it banks over', () => {
  const elf = join(ROOT, 'dist', 'banks-probe-atari8-ntsc.xex.elf');
  if (!existsSync(elf)) return; // only after a build; the emulator test below makes one
  const nm = spawnSync(join(process.env.LLVM_MOS_HOME ?? '', 'bin', 'llvm-nm'), [elf]);
  if (nm.status !== 0) return;
  const end = [...String(nm.stdout).matchAll(/^([0-9a-f]{8}) [A-Za-z] __(?:bss_end|heap_start)$/gm)]
    .map(([, address]) => parseInt(address, 16));
  for (const address of end) assert.ok(address < 0x4000, `the program reaches ${address.toString(16)}`);
});

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
const HAS_SDK = Boolean(process.env.LLVM_MOS_HOME);

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
  'under atari800, banks.kib() finds nothing on an 800XL and 64 KiB on a 130XE',
  {
    skip: (!HAS_SDK && 'LLVM_MOS_HOME not set')
      || (process.platform !== 'darwin' && 'macOS only (the atari800 screenshot route is a window capture)')
      || (!onPath('atari800') && 'atari800 not on PATH'),
  },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-xe-test-'));
    try {
      const shots = {};
      for (const [name, hardware] of [['800xl', []], ['130xe', ['--hardware', 'model=130xe']]]) {
        const shot = join(scratch, `${name}.png`);
        const { code, stdout, stderr } = await runCli(
          ['run', 'atari8', ...hardware, '--screenshot', shot, 'test/banks-probe.8bs'],
          { timeoutMs: 90_000 },
        );
        assert.equal(code, 0, `8bs run atari8 ${hardware.join(' ')} --screenshot failed:\n${stdout}${stderr}`);
        // The window capture includes the title bar, so this reads a
        // border pixel below it, at the left edge of the picture.
        shots[name] = pixelAt(readFileSync(shot), 8, 200);
      }
      // banks-probe.8bs: dark red for no extended RAM, bright green for a
      // 130XE's 64 KiB.
      const [r, g, b] = shots['800xl'];
      assert.ok(r > g + 30 && r > b + 30, `800XL: a red border, got rgb(${shots['800xl']})`);
      const [gr, gg, gb] = shots['130xe'];
      assert.ok(gg > gr + 30 && gg > gb + 30, `130XE: a green border, got rgb(${shots['130xe']})`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
