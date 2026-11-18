// Regenerates fixtures/encode.json. Run from the repo root:
//   node crates/mos/tests/gen/encode.mjs
import { OPCODES, encode } from '../../../../packages/compiler/src/mos/asm/encode.ts';
import { write } from './util.mjs';

const modes = [
  'implied', 'accumulator', 'immediate', 'zeropage', 'zeropage,x', 'zeropage,y', 'absolute',
  'absolute,x', 'absolute,y', 'indirect', '(indirect,x)', '(indirect),y', 'relative',
];
const rows = [];
// Every mnemonic against every mode: the 154 good pairs and each mnemonic's error text.
for (const mnemonic of Object.keys(OPCODES)) {
  for (const mode of modes) rows.push({ fn: 'encode', args: [mnemonic, mode], result: encode(mnemonic, mode) });
}
// Unknown mnemonics: lowercase, empty, padded, made up.
for (const mnemonic of ['lda', 'XYZ', '', 'LDA ', 'STZ']) {
  rows.push({ fn: 'encode', args: [mnemonic, 'implied'], result: encode(mnemonic, 'implied') });
}
write('encode', rows);
