// Regenerates fixtures/relax.json. Run from the repo root:
//   node crates/mos/tests/gen/relax.mjs
import { assembleRelaxed, resetLabels } from '../../../../packages/compiler/src/mos/asm/relax.ts';
import { bytes, encodeAssembled, ins, lab, label, write } from './util.mjs';

const rows = [];
const add = (name, program, origin) => {
  resetLabels();
  const result = encodeAssembled(assembleRelaxed(program, origin));
  rows.push({ fn: 'assembleRelaxed', name, args: [program, origin], result });
  return result;
};
const pad = (n) => bytes(...new Array(n).fill(0xea));

add('short branch untouched', [ins('BNE', 'relative', lab('e')), pad(10), label('e')], 0x0801);
add('one branch at +200', [ins('BNE', 'relative', lab('e')), pad(200), label('e'), ins('RTS', 'implied')], 0x0801);
add('backward far', [label('s'), pad(200), ins('BCC', 'relative', lab('s')), ins('RTS', 'implied')], 0x0801);
for (const m of ['BEQ', 'BNE', 'BCC', 'BCS', 'BVC', 'BVS', 'BPL', 'BMI']) {
  add(`inverse ${m}`, [ins(m, 'relative', lab('e')), pad(300), label('e')], 0x0801);
}

// A chain: relaxing a later branch pushes an earlier one out of range. Search for a shape that
// needs three relaxations.
let found = null;
for (let p = 100; p <= 130 && !found; p++) {
  for (let x = 0; x <= 20 && !found; x++) {
    const program = [
      ins('BEQ', 'relative', lab('mid')), ins('BNE', 'relative', lab('mid')), ins('BCC', 'relative', lab('far')),
      pad(p), label('mid'), pad(x), label('far'), ins('RTS', 'implied'),
    ];
    resetLabels();
    const r = encodeAssembled(assembleRelaxed(program, 0x0801));
    if (r.ok && r.labels.some(([k]) => k === '__8bs_relax_2')) found = { program, p, x };
  }
}
if (!found) throw new Error('no 3-pass chain found');
add(`chain of three (pad ${found.p}, ${found.x})`, found.program, 0x0801);

add('5-digit address is not matched', [ins('BNE', 'relative', lab('e')), pad(200), label('e')], 0x10000);
add('non-branch error passes through', [ins('LDA', 'absolute', lab('nope')), ins('BNE', 'relative', lab('e')), pad(200), label('e')], 0x0801);
add('unknown label in far branch', [ins('BNE', 'relative', lab('nope'))], 0x0801);
write('relax', rows);
