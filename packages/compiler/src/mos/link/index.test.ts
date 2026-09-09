import { test } from 'node:test';
import assert from 'node:assert/strict';

import { link } from './index.ts';
import type { LinkInput } from './index.ts';

const bytes = (...values: number[]): { kind: 'bytes'; bytes: Uint8Array } => ({ kind: 'bytes', bytes: Uint8Array.from(values) });

test('code alone: placed at codeOrigin, nothing else touched', () => {
  const result = link({ codeOrigin: 0x040d, ramCeiling: 0x2000, code: bytes(0x60) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual([...result.bytes], [0x60]);
  assert.deepEqual(result.layout, [
    { name: 'code', origin: 0x040d, size: 1 },
    { name: 'data', origin: 0x040e, size: 0 },
    { name: 'bss', origin: 0x040e, size: 0 },
    { name: 'zp', origin: 0x02, size: 0 },
  ]);
  assert.deepEqual(result.memory, { variables: 0, program: 1 });
});

test('code, then data, then bss: placed one after another with no gaps, deterministically', () => {
  const input: LinkInput = { codeOrigin: 0x0400, ramCeiling: 0x2000, code: bytes(0xa9, 0x08, 0x8d, 0x00, 0x80), data: bytes(0x01, 0x02, 0x03), bss: 4 };
  const first = link(input);
  const second = link(input);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(first.layout, second.layout, 'placement is a pure function of the input');
  assert.deepEqual(first.layout, [
    { name: 'code', origin: 0x0400, size: 5 },
    { name: 'data', origin: 0x0405, size: 3 },
    { name: 'bss', origin: 0x0408, size: 4 },
    { name: 'zp', origin: 0x02, size: 0 },
  ]);
  // Only code and data reach the file; bss is reserved space, never bytes.
  assert.deepEqual([...first.bytes], [0xa9, 0x08, 0x8d, 0x00, 0x80, 0x01, 0x02, 0x03]);
  assert.deepEqual(first.memory, { variables: 4, program: 8 });
});

test('a program that overflows the RAM ceiling is refused, naming the section and the exact overage', () => {
  // The 2001's real ceiling: 4K total, load address $0401 already spent on
  // BASIC's own overhead, code starting at $040D (1037) as basicStub()
  // computes it. 3060 bytes of bss pushes the end 2 bytes past 4096.
  const result = link({ codeOrigin: 1037, ramCeiling: 4096, code: bytes(0x60), bss: 3060 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /^bss: program ends at \$1002, 2 byte\(s\) past the \$1000 RAM ceiling$/);
});

test('code alone can already overflow a small enough ceiling, named as code, not as a later section', () => {
  const result = link({ codeOrigin: 1037, ramCeiling: 1024, code: bytes(0x60) });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /^code: program ends at \$040E, 14 byte\(s\) past the \$0400 RAM ceiling$/);
});

test('an assembled section resolves its own labels, offset by wherever the linker placed it', () => {
  const result = link({
    codeOrigin: 0x0400,
    ramCeiling: 0x2000,
    code: { kind: 'assembly', program: [{ kind: 'label', name: 'start' }, { kind: 'instruction', mnemonic: 'RTS', mode: 'implied' }] },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.symbols.get('start'), 0x0400);
});

test('the same label defined in both code and data is refused, naming it', () => {
  const label = (name: string) => ({ kind: 'label' as const, name });
  const rts = { kind: 'instruction' as const, mnemonic: 'RTS', mode: 'implied' as const };
  const result = link({
    codeOrigin: 0x0400,
    ramCeiling: 0x2000,
    code: { kind: 'assembly', program: [label('here'), rts] },
    data: { kind: 'assembly', program: [label('here'), rts] },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /'here' is already defined in code/);
});

test('zp is placed at its own origin, separate from code/data/bss, and checked against its own ceiling', () => {
  const result = link({ codeOrigin: 0x0400, ramCeiling: 0x2000, code: bytes(0x60), zpOrigin: 0x02, zp: 10 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.layout.find((s) => s.name === 'zp'), { name: 'zp', origin: 0x02, size: 10 });
  assert.equal(result.memory.variables, 10);

  const overflow = link({ codeOrigin: 0x0400, ramCeiling: 0x2000, code: bytes(0x60), zpOrigin: 0xf8, zp: 10 });
  assert.equal(overflow.ok, false);
  if (overflow.ok) return;
  assert.match(overflow.error, /^zp: reserves up to \$0102, 2 byte\(s\) past the \$0100 zero-page ceiling$/);
});

test('a pinned symbol landing inside a placed section is refused, naming the section and its range', () => {
  const result = link({
    codeOrigin: 0x0400,
    ramCeiling: 0x2000,
    code: bytes(0x60, 0x60, 0x60),
    pinned: [{ name: 'CHROUT', address: 0x0401 }],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /^pinned symbol 'CHROUT' at \$0401 falls inside the code section \(\$0400-\$0402\)$/);
});

test('a pinned symbol outside every section joins the merged symbol table', () => {
  const result = link({
    codeOrigin: 0x0400,
    ramCeiling: 0x2000,
    code: bytes(0x60),
    pinned: [{ name: 'CHROUT', address: 0xffd2 }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.symbols.get('CHROUT'), 0xffd2);
});
