// Regenerates fixtures/startup.json: every exported startup generator, each
// over 3 bases, from the JS. Run from the repo root:
//   node crates/mos/tests/gen/startup.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as commodore from '../../../../packages/compiler/src/mos/startup/commodore.ts';
import * as multiply from '../../../../packages/compiler/src/mos/startup/multiply.ts';
import { nesResetInit } from '../../../../packages/compiler/src/mos/startup/nes.ts';

const rows = [];
const add = (fn, args, result) => rows.push({ fn, args, result });

const ins = (mnemonic, mode, operand) => (operand ? { kind: 'instruction', mnemonic, mode, operand } : { kind: 'instruction', mnemonic, mode });
const programs = [
  [],
  [{ kind: 'label', name: 'x' }, { kind: 'byte', values: [1, 2] }],
  [ins('LDA', 'immediate', { kind: 'value', value: 1 }), ins('RTS', 'implied')],
  [ins('NOP', 'implied'), ins('ADC', 'immediate', { kind: 'value', value: 1 })],
  [ins('SBC', 'zeropage', { kind: 'value', value: 4 })],
  [{ kind: 'equate', name: 'ADC', value: 1 }, { kind: 'label', name: 'SBC' }],
];
for (const p of programs) add('usesDecimalSensitiveMath', [p], commodore.usesDecimalSensitiveMath(p));
for (const flag of [false, true]) add('prologue', [flag], commodore.prologue(flag));
add('epilogue', [], commodore.epilogue());
// PET (0x90), C64 (0x02) and a high base (0xc2); byte counts across the edges.
for (const origin of [0x02, 0x90, 0xc2]) {
  for (const bytes of [-3, 0, 1, 7, 100, 256]) {
    add('borrowZeroPage', [origin, bytes], commodore.borrowZeroPage(origin, bytes));
    add('returnZeroPage', [origin, bytes], commodore.returnZeroPage(origin, bytes));
    add('zeroPageSaveData', [bytes], commodore.zeroPageSaveData(bytes));
  }
}
add('MULTIPLY_LABEL', [], multiply.MULTIPLY_LABEL);
add('MULTIPLY_ZP_BYTES', [], multiply.MULTIPLY_ZP_BYTES);
for (const base of [0x02, 0x80, 0xe0]) {
  const cells = multiply.multiplyCells(base);
  add('multiplyCells', [base], cells);
  add('multiplyRoutine', [cells], multiply.multiplyRoutine(cells));
}
add('nesResetInit', [], nesResetInit());

mkdirSync(fileURLToPath(new URL('../fixtures', import.meta.url)), { recursive: true });
writeFileSync(fileURLToPath(new URL('../fixtures/startup.json', import.meta.url)), `${JSON.stringify(rows)}\n`);
