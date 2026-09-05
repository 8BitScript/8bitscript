// 8BS3003: a write the target's own documentation says can damage the
// machine. One entry today — the PET's "killer poke", $E842 (the VIA's
// data-direction register B) with bit 5 set — and these tests hold the rule
// to its stated shape: refused when the value is a compile-time constant
// with bit 5 set or a runtime value; allowed when it is a compile-time
// constant with bit 5 clear; never a concern for reads, for other
// addresses, or for other machines. The check is the linker's, so it sees
// consts from other modules inlined (packages/compiler/src/linker/hazards.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { link } from '../index.mjs';

const codes = (diagnostics) => diagnostics.map((d) => d.code);

const program = (body) => `export function main(): void {\n${body}\n}\n`;

test('memory.write to $E842 with bit 5 set is 8BS3003 on the PET, at the call', () => {
  const src = program('    memory.write(0xE842, 62);');
  const { diagnostics } = link(src, '/x/main.8bs', { machine: 'pet' });
  assert.deepEqual(codes(diagnostics), ['8BS3003']);
  assert.match(diagnostics[0].message, /killer poke/);
  assert.match(diagnostics[0].message, /writing 62 to the VIA's data-direction register B \(\$E842, POKE 59458\) on the pet/);
  assert.equal(diagnostics[0].file, '/x/main.8bs');
  assert.equal(src.slice(diagnostics[0].start, diagnostics[0].start + diagnostics[0].length), 'memory.write(0xE842, 62)');
});

test('the same write with bit 5 clear, a read, another address, or another machine is fine', () => {
  for (const body of [
    '    memory.write(0xE842, 0x1E);', // the DDRB value the KERNAL itself uses
    '    memory.write(0xE842, 0);',
    '    let v: utinyint = memory.read(0xE842);',
    '    memory.write(0xE843, 62);',
  ]) {
    assert.deepEqual(codes(link(program(body), '/x/main.8bs', { machine: 'pet' }).diagnostics), [], body);
  }
  const killer = program('    memory.write(0xE842, 62);');
  for (const machine of ['c64', 'vic20', 'nes', undefined]) {
    assert.deepEqual(codes(link(killer, '/x/main.8bs', { machine }).diagnostics), [], String(machine));
  }
});

test('a runtime value to $E842 cannot be proved safe and is refused', () => {
  const src = 'let mode: utinyint = 0;\n' + program('    memory.write(0xE842, mode);');
  const { diagnostics } = link(src, '/x/main.8bs', { machine: 'pet' });
  assert.deepEqual(codes(diagnostics), ['8BS3003']);
  assert.match(diagnostics[0].message, /writing a runtime value to/);
});

test('an @address global at $E842: assigning a bad constant or a runtime value is refused, a safe constant and reads are not', () => {
  const decl = '@address(0xE842)\nlet ddrb: volatile<u8>;\nlet mode: utinyint = 0;\n';
  const refused = ['    ddrb = 62;', '    ddrb = mode;', '    ddrb++;'];
  for (const body of refused) {
    const { diagnostics } = link(decl + program(body), '/x/main.8bs', { machine: 'pet' });
    assert.deepEqual(codes(diagnostics), ['8BS3003'], body);
    assert.equal(diagnostics[0].start, (decl + program(body)).indexOf(body.trim()), body);
  }
  for (const body of ['    ddrb = 0x1E;', '    mode = ddrb;']) {
    assert.deepEqual(codes(link(decl + program(body), '/x/main.8bs', { machine: 'pet' }).diagnostics), [], body);
  }
});

test('an @address array spanning $E842: the element that is it is checked; a runtime index is refused', () => {
  const decl = '@address(0xE840)\nlet via: array<u8, 16>;\nlet i: utinyint = 2;\n';
  assert.deepEqual(codes(link(decl + program('    via[2] = 62;'), '/x/main.8bs', { machine: 'pet' }).diagnostics), ['8BS3003']);
  assert.deepEqual(codes(link(decl + program('    via[2] = 0x1E;'), '/x/main.8bs', { machine: 'pet' }).diagnostics), []);
  assert.deepEqual(codes(link(decl + program('    via[3] = 62;'), '/x/main.8bs', { machine: 'pet' }).diagnostics), []);
  const { diagnostics } = link(decl + program('    via[i] = 0x1E;'), '/x/main.8bs', { machine: 'pet' });
  assert.deepEqual(codes(diagnostics), []); // a safe value is safe wherever it lands
  const runtime = link(decl + program('    via[i] = 62;'), '/x/main.8bs', { machine: 'pet' });
  assert.deepEqual(codes(runtime.diagnostics), ['8BS3003']);
  assert.match(runtime.diagnostics[0].message, /runtime index cannot be proved to miss \$E842/);
});

test('the address and the value may both be consts from another module: the linker sees the write for what it is', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-hazards-'));
  try {
    await writeFile(join(dir, 'via.8bs'), 'export const DDRB: usmallint = 0xE842;\nexport const FAST: utinyint = 62;\nexport const NORMAL: utinyint = 0x1E;\n');
    const main = (value) => `import { DDRB, ${value} } from "./via.8bs";\n${program(`    memory.write(DDRB, ${value});`)}`;
    await writeFile(join(dir, 'main.8bs'), main('FAST'));
    const bad = link(main('FAST'), join(dir, 'main.8bs'), { machine: 'pet' });
    assert.deepEqual(codes(bad.diagnostics), ['8BS3003']);
    assert.match(bad.diagnostics[0].message, /writing 62 to/);
    const good = link(main('NORMAL'), join(dir, 'main.8bs'), { machine: 'pet' });
    assert.deepEqual(codes(good.diagnostics), []);
    assert.ok(good.ir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
