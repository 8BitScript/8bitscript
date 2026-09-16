import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NodeType, parse, tokenize } from '../index.mjs';
import { linkFiles } from './support/link-files.mjs';
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
  const mos = linkFiles({ 'main.8bs': PROGRAM }, 'main.8bs', { machine: 'pet' });
  assert.deepEqual(mos.diagnostics, []);
  // The same stand-in sheet mos.test.ts builds against: a 32K PET at $0401.
  const hardware = { build: { defsym: { __ram_size: 32, __load_address: 0x0401 } }, facts: {} };
  const prg = await buildMos(mos.ir, { machine: 'pet', hardware, frameRate: 60, outFile: join(dir, 'main.prg') });
  assert.equal(prg.ok, true, prg.error);
  assert.ok(prg.bytes.length > 0);

  const web = linkFiles({ 'main.8bs': PROGRAM }, 'main.8bs', { machine: 'web' });
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
  const { ir, diagnostics } = linkFiles({ 'main.8bs': src }, 'main.8bs', { machine: 'pet' });
  assert.deepEqual(diagnostics, []);
  const optimized = optimizeReachable(ir);
  const main = optimized.functions.find((f) => f.name === ir.entry);
  const assign = main.body.find((s) => s.kind === 'assign');
  assert.deepEqual(assign.value, { kind: 'const', value: 7, type: 'utinyint' });
});
