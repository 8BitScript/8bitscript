// Regenerates fixtures/wasm-encode.json: what `wasm/encode.ts` computes. Run from the repo root:
//   node crates/wasm/tests/gen/wasm-encode.mjs
// Each row is { fn, args, result }; a throw is recorded as { throw: message }.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as e from '../../../../packages/compiler/src/wasm/encode.ts';

const rows = [];
const run = (fn, ...args) => {
  let result;
  try {
    const value = e[fn](...args);
    result = [...value];
  } catch (error) {
    result = { throw: error.message };
  }
  // JSON has no undefined: a trailing/absent argument is null.
  rows.push({ fn, args: args.map((a) => (a === undefined ? null : a)), result });
};

const unsigned = [0, 1, 127, 128, 255, 2 ** 31, 2 ** 32 - 1, 2 ** 53 - 1, -1, 1.5];
for (const v of unsigned) run('unsignedLEB128', v);
const signed = [0, 1, -1, 63, -63, 64, -64, 127, -127, 128, -128, 2 ** 31 - 1, -(2 ** 31), 2 ** 31, 2 ** 32 - 1, 1.5];
for (const v of signed) run('signedLEB128', v);
run('limits', 1);
run('limits', 1, 2);
run('limits', 1, 2, true);
run('limits', 1, undefined, true);
run('vector', []);
run('vector', [[1, 2], [3], []]);
for (const name of ['', 'env', 'é']) run('encodeName', name);
run('memarg', 0, 0);
run('memarg', 2, 300);
run('memarg', -1, 0);
run('activeDataSegment', 0, []);
run('activeDataSegment', 1024, [1, 2, 3]);
run('activeDataSegment', -5, [9]);
run('funcType', [], []);
run('funcType', [e.ValType.i32, e.ValType.i32], [e.ValType.i32]);
run('importFunc', 'env', 'waitFrame', 0);
run('importFunc', 'env', 'x', 200);
run('section', e.SectionId.type, [1, 2, 3]);
run('section', e.SectionId.code, Array.from({ length: 130 }, (_, i) => i));
run('assembleModule', []);
run('assembleModule', [[1, 1, 0], [3, 2, 1, 0]]);
run('memoryCopy');

const consts = {
  ValType: e.ValType, SectionId: e.SectionId, ExternalKind: e.ExternalKind, BlockType: e.BlockType,
  Opcode: e.Opcode, Mutability: e.Mutability, MODULE_HEADER: [...e.MODULE_HEADER],
};

const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}wasm-encode.json`, `${JSON.stringify({ rows, consts })}\n`);
console.log(`wasm-encode: ${rows.length} rows`);
