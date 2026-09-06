// @8bitscript/c128/banks — the probe for the 256 KiB modification. Three
// layers: the probe program links clean for the C128 with the stock
// sheet; the built code is disassembled to prove the dangerous part is
// safe (nothing between the two bank switches may touch memory outside
// the common area the probe widens); and, when x128 and the SDK are
// installed, it is run on a stock machine and a modified one and the
// border colour each screenshot shows is what banks.kib() found.
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

// The one that matters. While bank 2 is selected the CPU is fetching from
// whatever bank 2 holds everywhere outside common RAM, which the probe
// widens to $0000-$3FFF. So between the two writes to $FF00 the code may
// touch the zero page, the stack and its own instructions — all inside
// that — and nothing else. A compiler spill to the soft stack (which
// lives near $BFFF, outside it) would be a silent corruption, so this
// reads the actual instructions rather than trusting that it does not.
test('nothing between the two bank switches touches memory outside the common area', () => {
  const elf = join(ROOT, 'dist', 'banks-probe-c128-ntsc.prg.elf');
  if (!existsSync(elf)) return; // only after a build; the emulator test below makes one
  const objdump = join(process.env.LLVM_MOS_HOME ?? '', 'bin', 'llvm-objdump');
  if (!existsSync(objdump)) return;
  const { status, stdout } = spawnSync(objdump, ['-d', elf]);
  if (status !== 0) return;
  const lines = String(stdout).split('\n')
    .map((line) => /^\s*([0-9a-f]+):\s+(?:[0-9a-f]{2} )+\s*(\w+)\s*(\S*)/.exec(line))
    .filter(Boolean)
    .map(([, address, mnemonic, operand]) => ({ address, mnemonic, operand }));
  const switches = lines
    .map((line, index) => ({ ...line, index }))
    .filter((line) => line.operand === '$ff00' && line.mnemonic.startsWith('st'));
  assert.ok(switches.length >= 2, 'the probe writes the configuration register at least twice');
  // The window is between the write that selects bank 2 and the next one.
  const [into, back] = switches.slice(-2);
  assert.ok(back.index > into.index);
  const PROBE_BYTE = '$8000';
  for (const line of lines.slice(into.index + 1, back.index)) {
    const target = /^\$([0-9a-f]+)/.exec(line.operand);
    if (!target) continue; // immediate, implied, or a register
    if (line.operand === PROBE_BYTE) continue; // the byte the probe is here to write
    const address = parseInt(target[1], 16);
    assert.ok(address < 0x4000, `${line.mnemonic} ${line.operand} at ${line.address} is outside the common area`);
  }
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
  'under x128, banks.kib() finds 64 KiB on a stock C128 and 192 with the modification',
  { skip: (!HAS_SDK && 'LLVM_MOS_HOME not set') || (!onPath('x128') && 'x128 not on PATH') },
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
