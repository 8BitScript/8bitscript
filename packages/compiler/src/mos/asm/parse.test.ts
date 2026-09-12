import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAsm } from './parse.ts';
import { assemble } from './assemble.ts';

/** The mnemonics and modes a block parsed to, which is what callers actually care about. */
const shape = (text: string, id = 'b0') => {
  const parsed = parseAsm(text, id);
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
  if (!parsed.ok) return [];
  return parsed.directives.map((d) => {
    if (d.kind === 'instruction') return `${d.mnemonic} ${d.mode}`;
    if (d.kind === 'label') return `label ${d.name}`;
    return d.kind;
  });
};

const errorOf = (text: string) => {
  const parsed = parseAsm(text, 'b0');
  assert.equal(parsed.ok, false, 'expected a refusal');
  return parsed.ok ? '' : parsed.error;
};

test('the implied instructions the machine packages actually use', () => {
  assert.deepEqual(shape('sei\ncli\ndex\nsec'), ['SEI implied', 'CLI implied', 'DEX implied', 'SEC implied']);
});

test('case does not matter, and a block may be one line', () => {
  assert.deepEqual(shape('  SEI  '), ['SEI implied']);
  assert.deepEqual(shape('LdA #$FF'), ['LDA immediate']);
});

test('immediates take $hex, %binary and decimal, and refuse what will not fit a byte', () => {
  const parsed = parseAsm('lda #$FF\nldx #%1010\nldy #8', 'b0');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.directives.map((d) => (d.kind === 'instruction' ? d.operand : null)), [
    { kind: 'value', value: 0xff },
    { kind: 'value', value: 0b1010 },
    { kind: 'value', value: 8 },
  ]);
  assert.match(errorOf('lda #$100'), /does not fit in one byte/);
});

test("a literal's own written width chooses zero page or absolute", () => {
  // `sta $84` is two digits, so it is the zero-page store the C64 package
  // means; `$0084` would have been the absolute one, and is a different
  // instruction with a different length.
  assert.deepEqual(shape('sta $84'), ['STA zeropage']);
  assert.deepEqual(shape('sta $0084'), ['STA absolute']);
  assert.deepEqual(shape('lda $D012'), ['LDA absolute']);
});

test('a mnemonic with no zero-page form widens rather than being refused', () => {
  // JSR has only an absolute form, so `jsr $84` is absolute — the width
  // rule above cannot make an instruction the 6502 does not have.
  assert.deepEqual(shape('jsr $84'), ['JSR absolute']);
  assert.deepEqual(shape('jsr $FF5F'), ['JSR absolute']);
});

test('a symbol operand is a label, and starts wide because it has no width to read', () => {
  const parsed = parseAsm('jsr __8bs_c64_raster_install', 'b0');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.directives[0], {
    kind: 'instruction', mnemonic: 'JSR', mode: 'absolute',
    operand: { kind: 'label', name: '__8bs_c64_raster_install' },
  });
});

test('the indexed and indirect shapes', () => {
  assert.deepEqual(shape('lda $10,x'), ['LDA zeropage,x']);
  assert.deepEqual(shape('lda $1000,x'), ['LDA absolute,x']);
  assert.deepEqual(shape('ldx $10,y'), ['LDX zeropage,y']);
  assert.deepEqual(shape('lda ($10,x)'), ['LDA (indirect,x)']);
  assert.deepEqual(shape('lda ($10),y'), ['LDA (indirect),y']);
  assert.deepEqual(shape('jmp ($FFFC)'), ['JMP indirect']);
  assert.deepEqual(shape('asl a'), ['ASL accumulator']);
});

test('comments run to end of line, after ; or //', () => {
  assert.deepEqual(shape('sei ; interrupts off\n// a whole line\ncli // and back on'), ['SEI implied', 'CLI implied']);
});

test('a local label and a backward branch to it — the c128 mouse-settle loop, verbatim', () => {
  // packages/c128/src/input.8bs: 256 DEX/BNE is ~1.3ms at 1MHz, which is
  // what the SID needs after the port bits change.
  const parsed = parseAsm('ldx #0\n1:\ndex\nbne 1b', 'blk');
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
  if (!parsed.ok) return;
  const branch = parsed.directives.at(-1)!;
  assert.equal(branch.kind === 'instruction' && branch.mode, 'relative');
  const target = branch.kind === 'instruction' && branch.operand?.kind === 'label' ? branch.operand.name : '';
  assert.equal(target, '__asm_blk_1_0');
  assert.ok(parsed.directives.some((d) => d.kind === 'label' && d.name === target), 'the label it branches to is defined');
  // And it assembles: DEX is one byte, so the branch reaches back two.
  const asm = assemble(parsed.directives, 0xc000);
  assert.equal(asm.ok, true, asm.ok ? '' : asm.error);
  if (!asm.ok) return;
  assert.deepEqual([...asm.bytes], [0xa2, 0x00, 0xca, 0xd0, 0xfd]);
});

test("a block's local labels are its own: the same `1:` in two blocks is two places", () => {
  const first = parseAsm('1:\nbne 1b', 'one');
  const second = parseAsm('1:\nbne 1b', 'two');
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  const nameOf = (ds: typeof first.directives) => ds.find((d) => d.kind === 'label')!.name;
  assert.notEqual(nameOf(first.directives), nameOf(second.directives));
});

test('a forward local reference finds the label ahead of it', () => {
  const parsed = parseAsm('bne 1f\ndex\n1:\nsec', 'b0');
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
  if (!parsed.ok) return;
  const branch = parsed.directives[0];
  const target = branch.kind === 'instruction' && branch.operand?.kind === 'label' ? branch.operand.name : '';
  assert.ok(parsed.directives.some((d) => d.kind === 'label' && d.name === target));
});

test('a named label may share its line with the instruction that follows it', () => {
  assert.deepEqual(shape('loop: dex'), ['label loop', 'DEX implied']);
});

test('what it refuses, by name', () => {
  assert.match(errorOf('frobnicate'), /'frobnicate' is not a 6502 instruction/);
  assert.match(errorOf('sei #1'), /SEI has no immediate form/);
  assert.match(errorOf('lda'), /LDA needs an operand/);
  assert.match(errorOf('bne 9b'), /no label '9:' before it/);
  assert.match(errorOf('lda #$ZZ'), /is not an immediate value/);
  // The line number and the line itself are in the message: an asm block is
  // hand-written, so a refusal has to say which line of it.
  assert.match(errorOf('sei\ncli\nfrobnicate'), /asm6502 line 3 \('frobnicate'\)/);
});
