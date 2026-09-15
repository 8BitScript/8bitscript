import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assembleNative, referencedLabels } from './native.ts';
import type { Directive } from './asm/assemble.ts';

const src = (path: string, ...lines: string[]) => ({ path, text: lines.join('\n') });

/** A JSR to `name`, the shape an asm6502 block or a lowered call leaves in the program. */
const jsr = (name: string): Directive => ({ kind: 'instruction', mnemonic: 'JSR', mode: 'absolute', operand: { kind: 'label', name } });

const ok = (sources: { path: string; text: string }[], referenced: Iterable<string> = []) => {
  const result = assembleNative(sources, new Set(referenced));
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) throw new Error('unreachable');
  return result;
};

const errorOf = (sources: { path: string; text: string }[], referenced: Iterable<string> = []) => {
  const result = assembleNative(sources, new Set(referenced));
  assert.equal(result.ok, false, 'expected a refusal');
  return result.ok ? '' : result.error;
};

const labelsOf = (program: Directive[]) => program.filter((d) => d.kind === 'label').map((d) => d.name);

test('splits a source into sections: .init joins initProgram, a reached .text joins textProgram, .global is dropped', () => {
  const result = ok([src('lib.s',
    '; a comment before any section',
    '.section .init.10,"ax",@progbits',
    '    lda #<helper',
    '    sta 0xFFFA',
    '.section .text.helper,"ax",@progbits',
    '.global helper',
    'helper:',
    '    rts',
  )]);
  assert.deepEqual(result.initProgram, [
    { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'label', name: 'helper', byte: 'lo' } },
    { kind: 'instruction', mnemonic: 'STA', mode: 'absolute', operand: { kind: 'value', value: 0xfffa } },
  ]);
  // The .global line itself produces nothing; the label and the rti do.
  assert.deepEqual(result.textProgram, [
    { kind: 'label', name: 'helper' },
    { kind: 'instruction', mnemonic: 'RTS', mode: 'implied' },
  ]);
  assert.deepEqual(result.entries, [
    { name: '(native .init.10)', bytes: 5 },
    { name: '(native .text.helper)', bytes: 1 },
  ]);
});

test('.init.N sections come out ascending by N, across source order and across files', () => {
  const result = ok([
    src('b.s',
      '.section .init.250,"ax",@progbits',
      '    lda #250',
      '.section .init.5,"ax",@progbits',
      '    lda #5',
    ),
    src('a.s',
      '.section .init.100,"ax",@progbits',
      '    lda #100',
    ),
  ]);
  const values = result.initProgram.map((d) => (d.kind === 'instruction' && d.operand?.kind === 'value' ? d.operand.value : -1));
  assert.deepEqual(values, [5, 100, 250]);
  assert.deepEqual(result.entries.map((e) => e.name), ['(native .init.5)', '(native .init.100)', '(native .init.250)']);
});

test('an unreferenced .text.* is dropped; a referenced one is kept, and keeps what it reaches transitively', () => {
  const sources = [src('lib.s',
    '.section .text.outer,"ax",@progbits',
    'outer:',
    '    jsr inner',
    '    rts',
    '.section .text.inner,"ax",@progbits',
    'inner:',
    '    rts',
    '.section .text.orphan,"ax",@progbits',
    'orphan:',
    '    rts',
  )];
  // Nothing referenced: every .text section is dropped.
  assert.deepEqual(ok(sources).textProgram, []);
  // The program names only `outer`; `inner` rides along because outer's
  // own body reaches it, and `orphan` still falls away.
  const result = ok(sources, ['outer']);
  assert.deepEqual(labelsOf(result.textProgram), ['outer', 'inner']);
  assert.deepEqual(result.entries.map((e) => e.name), ['(native .text.outer)', '(native .text.inner)']);
});

test("an .init section's own references keep a .text.* the program never names", () => {
  // raster.s's real shape: .init.250 names __8bs_c64_rti, so the rti
  // section survives in a program that never imports the raster module.
  const result = ok([src('raster.s',
    '.section .init.250,"ax",@progbits',
    '    lda #<stub',
    '    sta 0xFFFA',
    '.section .text.stub,"ax",@progbits',
    'stub:',
    '    rti',
  )]);
  assert.deepEqual(labelsOf(result.textProgram), ['stub']);
});

test('referencedLabels collects label operands, which is what seeds the sweep', () => {
  const program: Directive[] = [
    jsr('installed'),
    { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value: 1 } },
    { kind: 'label', name: 'a_definition_not_a_reference' },
  ];
  assert.deepEqual([...referencedLabels(program)], ['installed']);
});

test('the whole real raster.s shape survives end to end: 0x literals, byte immediates, label+N', () => {
  const result = ok([src('raster.s',
    '.section .init.250,"ax",@progbits',
    '    lda #<rti_stub',
    '    sta 0xFFFA',
    '    sta 0xFFFE',
    '.section .text.rti_stub,"ax",@progbits',
    '.global rti_stub',
    'rti_stub:',
    '    rti',
    '.section .text.handler,"ax",@progbits',
    '.global handler',
    'handler:',
    '    lda 0x0201,x',
    '    sta handler_store+1',
    'handler_store:',
    '    sta 0xFFFF',
    '    rti',
  )], ['handler']);
  const store = result.textProgram.find((d) => d.kind === 'instruction' && d.operand?.kind === 'label' && d.operand.name === 'handler_store');
  assert.deepEqual(store, { kind: 'instruction', mnemonic: 'STA', mode: 'absolute', operand: { kind: 'label', name: 'handler_store', offset: 1 } });
  const first = result.initProgram[0];
  assert.deepEqual(first, { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'label', name: 'rti_stub', byte: 'lo' } });
  assert.deepEqual(labelsOf(result.textProgram), ['rti_stub', 'handler', 'handler_store']);
});

test("a section's leading .global is its public symbol, preferred over the .text suffix", () => {
  // The sweep keys on what the section exports: referencing the .global's
  // name keeps it, even though the suffix spells the symbol differently.
  const sources = [src('lib.s',
    '.section .text.helper_impl,"ax",@progbits',
    '.global helper',
    'helper:',
    '    rts',
  )];
  assert.deepEqual(labelsOf(ok(sources, ['helper']).textProgram), ['helper']);
  // And the suffix is NOT the key: naming it keeps nothing.
  assert.deepEqual(ok(sources, ['helper_impl']).textProgram, []);
});

test('a .text section that defines neither its suffix nor a .global is refused, not silently retained', () => {
  assert.match(
    errorOf([src('lib.s', '.section .text.f,"ax",@progbits', 'g:', '    rts')]),
    /'lib\.s': section '\.text\.f' never defines 'f' — a \.text\.<symbol> section must define its symbol, or name the label it exports with a leading \.global/,
  );
});

test('a kept section referencing a symbol no kept section defines is refused by name, not left to the assembler', () => {
  // An .init (always kept) naming a symbol no section defines at all.
  assert.match(
    errorOf([src('lib.s', '.section .init.1,"ax",@progbits', '    jsr missing')]),
    /'lib\.s': section '\.init\.1' references 'missing', which no kept native section defines/,
  );
  // A kept .text naming an interior label of a section the sweep dropped:
  // 'inner_detail' is not .text.other's public symbol, so 'other' never
  // survives, and the dangling reference is refused rather than half-linked.
  assert.match(
    errorOf([src('lib.s',
      '.section .text.f,"ax",@progbits', 'f:', '    jsr inner_detail', '    rts',
      '.section .text.other,"ax",@progbits', 'other:', 'inner_detail:', '    rts',
    )], ['f']),
    /'lib\.s': section '\.text\.f' references 'inner_detail', which no kept native section defines/,
  );
});

test('a label one section defines twice is refused at the native layer', () => {
  assert.match(
    errorOf([src('lib.s', '.section .text.f,"ax",@progbits', 'f:', '    rts', 'f:', '    rts')]),
    /'lib\.s': section '\.text\.f' defines 'f' twice/,
  );
});

test('what it refuses, by name and by file', () => {
  // A section shape this reader has no meaning for.
  assert.match(
    errorOf([src('lib.s', '.section .chr_rom,"ax",@progbits', '    rts')]),
    /'lib\.s' has a section '\.chr_rom' this native reader does not understand: only \.init\.N and \.text\.<symbol> are read/,
  );
  // A .section spelling that is not NAME,"ax",@progbits.
  assert.match(
    errorOf([src('lib.s', '.section .text.f,"a"', '    rts')]),
    /'lib\.s': '\.section \.text\.f,"a"' is not a section directive/,
  );
  // A .global naming a label its section never defines.
  assert.match(
    errorOf([src('lib.s', '.section .text.f,"ax",@progbits', '.global g', 'f:', '    rts')]),
    /'lib\.s': section '\.text\.f' declares '\.global g' but never defines that label/,
  );
  // A label two sections both define.
  assert.match(
    errorOf([src('lib.s',
      '.section .text.f,"ax",@progbits', 'f:', '    rts',
      '.section .text.g,"ax",@progbits', 'f:', 'g:', '    rts',
    )]),
    /section '\.text\.g' defines 'f', which .* already defines/,
  );
  // Code outside any section.
  assert.match(errorOf([src('lib.s', '    rts')]), /'lib\.s': 'rts' sits outside any section/);
  // A body line the assembler cannot read is the parser's refusal, named
  // with the file and section it came from.
  assert.match(
    errorOf([src('lib.s', '.section .init.1,"ax",@progbits', '    frobnicate')]),
    /'lib\.s', section '\.init\.1': .*'frobnicate' is not a 6502 instruction/,
  );
});
