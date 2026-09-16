import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NodeType, link, parse, tokenize } from '../index.mjs';
import { optimizeReachable } from '../src/linker/optimize.mjs';
import { build as buildMos } from '../src/mos/index.ts';
import { build as buildWasm } from '../src/wasm/index.ts';

test('parses a ternary expression', () => {
  const src = 'let x: u8 = true ? 1 : 2;\n';
  const { tokens } = tokenize(src, 't.8bs');
  const { ast, diagnostics } = parse(tokens, src, 't.8bs');
  assert.deepEqual(diagnostics, []);
  const decl = ast.body[0];
  assert.equal(decl.initializer?.type, NodeType.ConditionalExpression);
});

/** Link one .8bs program from a scratch directory, for `machine`. */
function linkProgram(src, machine) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-cond-'));
  try {
    const file = join(dir, 'main.8bs');
    writeFileSync(file, src);
    return link(src, file, { machine, frameRate: 60, facts: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PROGRAM = `let mode: utinyint = 0;
let out: utinyint = 0;
export function main(): void {
    mode = mode + 1;
    out = mode == 1 ? 7 : 9;
    memory.write(0x8000, out);
}
`;

test('a ?: with a run-time test lowers on both backends (spec §99: neither backend knows 8BX, both know its core)', async () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-cond-out-'));
  try {
  const mos = linkProgram(PROGRAM, 'pet');
  assert.deepEqual(mos.diagnostics, []);
  // The same stand-in sheet mos.test.ts builds against: a 32K PET at $0401.
  const hardware = { build: { defsym: { __ram_size: 32, __load_address: 0x0401 } }, facts: {} };
  const prg = await buildMos(mos.ir, { machine: 'pet', hardware, frameRate: 60, outFile: join(dir, 'main.prg') });
  assert.equal(prg.ok, true, prg.error);
  assert.ok(prg.bytes.length > 0);

  const web = linkProgram(PROGRAM, 'web');
  assert.deepEqual(web.diagnostics, []);
  const wasm = await buildWasm(web.ir, { frameRate: 60, outFile: join(dir, 'main.wasm') });
  assert.equal(wasm.ok, true, wasm.error);
  // The module is real wasm with the `if … else … end` inside main.
  assert.deepEqual([...wasm.bytes.slice(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ?: whose test is known at compile time is the taken arm, and the other is gone (§49)', () => {
  const src = `let out: utinyint = 0;
export function main(): void {
    out = 1 == 1 ? 7 : 9;
    memory.write(0x8000, out);
}
`;
  const { ir, diagnostics } = linkProgram(src, 'pet');
  assert.deepEqual(diagnostics, []);
  const optimized = optimizeReachable(ir);
  const main = optimized.functions.find((f) => f.name === ir.entry);
  const assign = main.body.find((s) => s.kind === 'assign');
  assert.deepEqual(assign.value, { kind: 'const', value: 7, type: 'utinyint' });
});
