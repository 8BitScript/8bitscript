// An imported const keeps the type it was declared with.
//
// `sprites.ORIGIN_X` is a `usmallint` holding 24 on the C64, and the
// C64 graphics fork found `sprites.ORIGIN_X + 236` wrapping at 8 bits to
// 4: the linker inlined a namespace const with the narrowest type that
// fits its value (`utinyint`), so the sum was an 8-bit sum. A same-module
// const already carried its declared type (ownConstTypes, ir/index.mjs);
// a namespace member now does too (`constTypes` on the IR namespace).
//
// Three layers: the IR says `usmallint`, the build is byte-for-byte the
// program that wrote the sum out by hand, and the 8-bit case keeps working.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from '../src/mos/index.ts';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';
import { linkFiles } from './support/link-files.mjs';

const LIB = `export namespace lib {
    const BASE: usmallint = 24;
    const SMALL: utinyint = 24;
    const FAR: usmallint = 300;
}
`;

// A second namespace whose const is another module's const: it is settled
// by the linker's pending pass, which must keep the declared type too.
const MID = `import { lib } from "./lib.8bs";
export namespace mid {
    const ORIGIN: usmallint = lib.BASE;
}
`;

const wrap = (body) => `import { lib } from "./lib.8bs";
import { mid } from "./mid.8bs";
let out: usmallint = 0;
let small: utinyint = 0;
export function main(): void {
${body}
}
`;

/** The type of the right-hand side of `out = ...` as the linker leaves it. */
function typeOfAssignedSum(body) {
  const { ir, diagnostics } = linkFiles({ 'lib.8bs': LIB, 'mid.8bs': MID, 'main.8bs': wrap(body) }, 'main.8bs', { machine: 'c64' });
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [], body);
  const main = ir.functions.find((f) => f.name === 'main');
  const assign = main.body.find((s) => s.kind === 'assign' && s.target === 'out');
  return assign.value;
}

test('a namespace const is inlined with its declared type, so the sum is 16 bits', () => {
  const value = typeOfAssignedSum('    out = lib.BASE + 236;');
  assert.equal(value.type, 'usmallint');
  assert.equal(value.left.type, 'usmallint');
  assert.equal(value.left.value, 24);
});

test('a const settled by the linker (a namespace const named by another) keeps the declared type', () => {
  const value = typeOfAssignedSum('    out = mid.ORIGIN + 236;');
  assert.equal(value.type, 'usmallint');
  assert.equal(value.left.type, 'usmallint');
});

test('a utinyint namespace const stays utinyint, and a wide one stays wide', () => {
  assert.equal(typeOfAssignedSum('    out = lib.SMALL + 1;').left.type, 'utinyint');
  assert.equal(typeOfAssignedSum('    out = lib.FAR + 1;').left.type, 'usmallint');
});

const c64Hardware = () => {
  const resolved = resolveHardware(loadCatalog('c64'), {});
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  return resolved.hardware;
};

async function c64Bytes(body) {
  const { ir, diagnostics } = linkFiles({ 'lib.8bs': LIB, 'mid.8bs': MID, 'main.8bs': wrap(body) }, 'main.8bs', { machine: 'c64' });
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [], body);
  const dir = mkdtempSync(join(tmpdir(), '8bs-const-width-'));
  try {
    const result = await build(ir, { machine: 'c64', hardware: c64Hardware(), outFile: join(dir, 'out.prg'), frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    return [...result.bytes];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('on the C64, lib.BASE + 236 builds to the program that stores 260', async () => {
  const imported = await c64Bytes('    out = lib.BASE + 236;');
  const literal = await c64Bytes('    out = 260;');
  assert.deepEqual(imported, literal);
  // And it is not the wrapped value: 24 + 236 in 8 bits is 4.
  const wrapped = await c64Bytes('    out = 4;');
  assert.notDeepEqual(imported, wrapped);
});

test('on the C64, a 16-bit comparison against an imported const is a 16-bit comparison', async () => {
  const imported = await c64Bytes('    if (lib.BASE + 236 > 255) { small = 1; }');
  const literal = await c64Bytes('    if (260 > 255) { small = 1; }');
  assert.deepEqual(imported, literal);
});
