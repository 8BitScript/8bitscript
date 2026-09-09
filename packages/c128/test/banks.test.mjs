// @8bitscript/c128/banks — the probe for the 256 KiB modification. Three
// layers: the probe program links clean for the C128 with the stock
// sheet; the built code is disassembled to prove the dangerous part is
// safe (nothing between the two bank switches may touch memory outside
// the common area the probe widens); and, when x128 and a working
// backend are installed, it is run on a stock machine and a modified one
// and the border colour each screenshot shows is what banks.kib() found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

test('the package exports ./banks, and the 256 KiB machine is the value found at run time by it', () => {
  assert.equal(pkg['8bitscript'].exports['./banks'], './src/banks.8bs');
  const { options } = loadCatalog('c128');
  assert.equal(options.ram.values['256k'].detect, '@8bitscript/c128/banks');
  assert.equal(options.ram.detect, undefined, 'not the whole option: every C128 has bank 1, so there is nothing to find');
});

test('the probe program links clean for the C128, and banks.kib() is a real function in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'c128', facts: stockFacts('c128') });
  assert.deepEqual(diagnostics, []);
  assert.ok(ir.functions.some((f) => f.name === 'banks_kib'));
});

const NATIVE_BACKEND_PENDING = 'Bare Metal: waiting on the native backend';

// The one that matters. While bank 2 is selected the CPU is fetching from
// whatever bank 2 holds everywhere outside common RAM, which the probe
// widens to $0000-$3FFF. So between the two writes to $FF00 the code may
// touch the zero page, the stack and its own instructions — all inside
// that — and nothing else. A compiler spill to the soft stack (which
// lives near $BFFF, outside it) would be a silent corruption, so this
// will read the actual instructions rather than trusting that it does not.
// TODO: once the native backend emits a disassemblable image, walk the
// instructions between the two $FF00 stores and refuse any absolute
// access at or above $4000 except the probe byte at $8000.
test('nothing between the two bank switches touches memory outside the common area', { skip: NATIVE_BACKEND_PENDING }, () => {});

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

test(
  'under x128, banks.kib() finds 64 KiB on a stock C128 and 192 with the modification',
  { skip: NATIVE_BACKEND_PENDING },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-c128-test-'));
    try {
      const shots = {};
      for (const [name, hardware] of [['128k', []], ['256k', ['--hardware', 'ram=256k']]]) {
        const shot = join(scratch, `${name}.png`);
        const { code, stdout, stderr } = await runCli(
          ['run', 'c128', ...hardware, '--screenshot', shot, 'test/banks-probe.8bs'],
          { timeoutMs: 90_000 },
        );
        assert.equal(code, 0, `8bs run c128 ${hardware.join(' ')} --screenshot failed:\n${stdout}${stderr}`);
        shots[name] = pixelAt(readFileSync(shot), 4, 4);
      }
      // banks-probe.8bs: red for the stock machine's 64 KiB, green for 192.
      const [r, g, b] = shots['128k'];
      assert.ok(r > g + 30 && r > b + 30, `stock: a red border, got rgb(${shots['128k']})`);
      const [gr, gg, gb] = shots['256k'];
      assert.ok(gg > gr + 30 && gg > gb + 30, `256 KiB: a green border, got rgb(${shots['256k']})`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
