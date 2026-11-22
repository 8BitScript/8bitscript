// Regenerates fixtures/wasm-lower.json: what `wasm/lower.ts:1-230` computes. Run from the repo root:
//   node crates/wasm/tests/gen/wasm-lower.mjs
// The helpers are module-private in lower.ts, so the script copies the file next to the original
// with an `export` line appended, imports the copy and deletes it. lower.ts itself is never edited.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INTEGER_TYPE_NAMES } from '../../../../packages/compiler/src/types/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = join(here, '..', '..', '..', '..', 'packages', 'compiler', 'src', 'wasm');
const copy = join(wasmDir, '.lower-export-for-fixtures.ts');
const names = ['i32Const', 'binding', 'maskToType', 'UNSIGNED_ORDERING', 'EQUALITY', 'operandIsSigned'];
writeFileSync(copy, `${readFileSync(join(wasmDir, 'lower.ts'), 'utf8')}\nexport { ${names.join(', ')} };\n`);
let m;
try {
  m = await import(pathToFileURL(copy).href);
} finally {
  rmSync(copy, { force: true });
}

const attempt = (f) => {
  try {
    const value = f();
    return value instanceof Uint8Array || Array.isArray(value) ? [...value] : value;
  } catch (error) {
    return { throw: error.message };
  }
};

const out = {};
out.i32Const = [0, 1, -1, 63, 64, 127, 128, 255, 256, 65535, 2 ** 31 - 1, -(2 ** 31), 2 ** 31, 2 ** 32 - 1, 1.5]
  .map((n) => ({ args: [n], result: attempt(() => m.i32Const(n)) }));

const types = [...INTEGER_TYPE_NAMES, 'bool', null, '', 'string', 'nope'];
out.maskToType = types.map((t) => ({ args: [[0x41, 0], t], result: attempt(() => m.maskToType([0x41, 0], t)) }));

out.operandIsSigned = [...types, undefined].map((t) => {
  const node = { kind: 'ref', name: 'x', ...(t === undefined ? {} : { type: t }) };
  return { node, result: m.operandIsSigned(node) };
});
const untyped = [
  { kind: 'const', value: 1 },
  { kind: 'const', value: 1, type: 'int' },
  { kind: 'binop', operator: '+', left: { kind: 'const', value: 1 }, right: { kind: 'const', value: 2 }, type: 'tinyint' },
  { kind: 'stringLength', string: { kind: 'string', index: 0 }, type: 'utinyint' },
];
out.operandIsSignedNodes = untyped.map((node) => ({ node, result: m.operandIsSigned(node) }));

const ctx = {
  locals: [['x', 0], ['s', 2]],
  globals: [['g', 1], ['s', 3]],
};
const mapCtx = { locals: new Map(ctx.locals), globals: new Map(ctx.globals) };
out.ctx = ctx;
out.binding = ['x', 'g', 's', 'missing'].map((name) => ({ name, result: attempt(() => m.binding(mapCtx, name)) }));

out.tables = {
  unsignedOrdering: Object.entries(m.UNSIGNED_ORDERING),
  equality: Object.entries(m.EQUALITY),
};

const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}wasm-lower.json`, `${JSON.stringify(out)}\n`);
console.log(`wasm-lower: ${out.i32Const.length + out.maskToType.length + out.operandIsSigned.length + out.operandIsSignedNodes.length + out.binding.length} rows`);
