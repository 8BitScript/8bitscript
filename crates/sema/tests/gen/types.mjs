// Regenerates fixtures/types.json: every export of packages/compiler/src/types/index.mjs over
// fixed inputs, from the JS.
// Run from the repo root: node crates/sema/tests/gen/types.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  INTEGER_RANGES,
  INTEGER_TYPE_NAMES,
  PRIMITIVE_INTEGER_TYPES,
  narrowestIntegerType,
  resolveIntegerType,
  storageBytes,
} from '../../../../packages/compiler/src/types/index.mjs';

const rows = [];
const add = (fn, args, result) => rows.push({ fn, args, result });

add('PRIMITIVE_INTEGER_TYPES', [], PRIMITIVE_INTEGER_TYPES);
add('INTEGER_TYPE_NAMES', [], INTEGER_TYPE_NAMES);
add('INTEGER_RANGES', [], INTEGER_RANGES);

const names = [
  ...INTEGER_TYPE_NAMES, 'bool', 'string', 'void', '', 'u64', 'i64', 'bigint', 'ubigint', 'UTINYINT', 'int ',
  'constructor', 'toString', '__proto__', 'byte', 'ptr', 'array',
];
for (const name of names) {
  add('resolveIntegerType', [name], resolveIntegerType(name) ?? null);
  add('storageBytes', [name], storageBytes(name));
}

const values = [
  -2147483649, -2147483648, -8388609, -8388608, -32769, -32768, -129, -128, -127, -2, -1, -0.5, 0, 0.5, 1, 127, 128,
  254, 255, 256, 32767, 32768, 65535, 65536, 8388607, 8388608, 16777215, 16777216, 2147483647, 2147483648, 4294967295,
  4294967296, 1e12, -1e12,
];
for (const value of values) add('narrowestIntegerType', [value], narrowestIntegerType(value));

writeFileSync(fileURLToPath(new URL('../fixtures/types.json', import.meta.url)), `${JSON.stringify(rows)}\n`);
console.log(`wrote ${rows.length} rows`);
