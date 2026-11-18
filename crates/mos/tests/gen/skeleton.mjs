// Regenerates fixtures/skeleton.json: JSON.stringify output of directives and
// the table rows for the PR-0 types. Run from the repo root:
//   node crates/mos/tests/gen/skeleton.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { operandBytes, instructionBytes } from '../../../../packages/compiler/src/mos/asm/encode.ts';
import { resolveIntegerType, storageBytes } from '../../../../packages/compiler/src/types/index.mjs';

const modes = [
  'implied', 'accumulator', 'immediate', 'zeropage', 'zeropage,x', 'zeropage,y', 'absolute',
  'absolute,x', 'absolute,y', 'indirect', '(indirect,x)', '(indirect),y', 'relative',
];
const prov = {
  source: { file: 'a.8bs', start: 3, length: 9 }, function: 'main', origin: null, component: null, instance: null,
};
const directives = [
  { kind: 'label', name: 'start' },
  { kind: 'label', name: 'loop', prov },
  { kind: 'instruction', mnemonic: 'NOP', mode: 'implied' },
  { kind: 'instruction', mnemonic: 'LDA', mode: 'immediate', operand: { kind: 'value', value: -5 } },
  { kind: 'instruction', mnemonic: 'LDA', mode: 'absolute,x', operand: { kind: 'label', name: 'tbl', byte: 'hi', offset: 250 }, prov },
  { kind: 'instruction', mnemonic: 'STA', mode: '(indirect),y', operand: { kind: 'label', name: 'p' } },
  { kind: 'instruction', mnemonic: 'BNE', mode: 'relative', operand: { kind: 'label', name: 'loop', byte: 'lo' }, prov: { ...prov, generated: { reason: 'relax' } } },
  { kind: 'byte', values: [0, 255, 1024] },
  { kind: 'byte', values: [], prov },
  { kind: 'equate', name: 'SCREEN', value: 1024 },
  { kind: 'equate', name: 'COLOR', value: 55296, prov },
];
const spellings = [
  'tinyint', 'i8', 'utinyint', 'u8', 'smallint', 'i16', 'usmallint', 'u16', 'mediumint', 'i24',
  'umediumint', 'u24', 'int', 'i32', 'uint', 'u32', 'bool', 'string', 'bigint', 'nonsense', '',
];
const out = {
  directives: directives.map((d) => JSON.stringify(d)),
  modes: modes.map((m) => [m, operandBytes(m), instructionBytes(m)]),
  types: spellings.map((s) => {
    const t = resolveIntegerType(s);
    return [s, t ? [t.canonicalName, t.signed, t.bits, t.bytes, t.min, t.max] : null, storageBytes(s)];
  }),
};
const target = fileURLToPath(new URL('../fixtures/skeleton.json', import.meta.url));
mkdirSync(fileURLToPath(new URL('../fixtures', import.meta.url)), { recursive: true });
writeFileSync(target, JSON.stringify(out) + '\n');
console.log(`directives ${out.directives.length}, modes ${out.modes.length}, types ${out.types.length}`);
