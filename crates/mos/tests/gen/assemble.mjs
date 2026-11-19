// Regenerates fixtures/assemble.json. Run from the repo root:
//   node crates/mos/tests/gen/assemble.mjs
import { assemble } from '../../../../packages/compiler/src/mos/asm/assemble.ts';
import { bytes, encodeAssembled, equate, ins, lab, label, val, write } from './util.mjs';

const rows = [];
const add = (name, program, origin) =>
  rows.push({ fn: 'assemble', name, args: [program, origin], result: encodeAssembled(assemble(program, origin)) });

add('every mode', [
  equate('SCREEN', 0x0400),
  label('start'),
  ins('NOP', 'implied'),
  ins('ASL', 'accumulator'),
  ins('LDA', 'immediate', val(0x41)),
  ins('LDA', 'immediate', lab('table', { byte: 'lo' })),
  ins('LDX', 'immediate', lab('table', { byte: 'hi' })),
  ins('LDA', 'zeropage', val(0x10)),
  ins('LDA', 'zeropage,x', val(0x10)),
  ins('LDX', 'zeropage,y', val(0x10)),
  ins('LDA', 'absolute', lab('SCREEN')),
  ins('LDA', 'absolute,x', lab('table', { offset: 250 })),
  ins('LDA', 'absolute,y', lab('table', { offset: 1 })),
  ins('JMP', 'indirect', val(0x0314)),
  ins('LDA', '(indirect,x)', val(0x20)),
  ins('LDA', '(indirect),y', val(0x20)),
  ins('BNE', 'relative', lab('start')),
  ins('BEQ', 'relative', lab('table')),
  label('table'),
  bytes(0, 1, 0x7f, 0xff),
  bytes(),
], 0x0801);
add('negative operand', [ins('LDA', 'absolute', val(-5))], 0x0400);
add('negative immediate', [ins('LDA', 'immediate', val(-1))], 0x0400);
add('offset negative', [label('a'), ins('LDA', 'absolute', lab('a', { offset: -2000 }))], 0x0400);
add('offset too high', [label('a'), ins('LDA', 'absolute', lab('a', { offset: 65535 }))], 0x0400);
add('origin past 16 bits', [label('a'), ins('LDA', 'absolute', lab('a'))], 0x10000);
add('duplicate label', [label('a'), label('a')], 0);
add('duplicate equate', [label('a'), equate('a', 1)], 0);
add('equate then label', [equate('a', 1), label('a')], 0);
add('equate out of range', [equate('a', 0x10000)], 0);
add('equate negative', [equate('a', -1)], 0);
add('byte too big', [bytes(1, 256)], 0x0400);
add('byte negative', [bytes(-1)], 0x0400);
add('unknown mnemonic', [ins('FOO', 'implied')], 0x0400);
add('bad mode', [ins('STA', 'immediate', val(1))], 0x0400);
add('no operand', [ins('LDA', 'absolute')], 0x0400);
add('undefined label', [ins('LDA', 'absolute', lab('nope'))], 0x0400);
add('branch forward edge', [ins('BNE', 'relative', lab('e')), bytes(...new Array(127).fill(0)), label('e')], 0x0400);
add('branch back edge', [label('s'), bytes(...new Array(126).fill(0)), ins('BNE', 'relative', lab('s'))], 0x0400);
add('branch too far', [ins('BNE', 'relative', lab('e')), bytes(...new Array(128).fill(0)), label('e')], 0x0400);
add('branch too far back', [label('s'), bytes(...new Array(127).fill(0)), ins('BNE', 'relative', lab('s'))], 0x0400);
add('zp operand too big', [ins('LDA', 'zeropage', val(0x100))], 0x0400);
add('zp operand negative', [ins('LDA', 'zeropage,x', val(-3))], 0x0400);
add('absolute too big', [ins('LDA', 'absolute', val(0x10000))], 0x0400);
add('indirect too big', [ins('JMP', 'indirect', val(70000))], 0x0400);
add('empty', [], 0x0801);
write('assemble', rows);
