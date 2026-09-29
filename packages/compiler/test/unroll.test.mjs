// @unroll: a `for` loop's own request to be fully unrolled past the
// automatic string-copy heuristic's small cap (optimize.mjs's
// MAX_UNROLL). Three layers, three kinds of failure:
//   - the decorator's own syntax (ir/index.mjs): only @unroll, no
//     arguments, only on a `for` — 8BS3001, the same code any other
//     "not compilable" shape uses.
//   - the loop's shape, once every const and `#fact` is inlined
//     (packages/compiler/src/linker/unroll.mjs) — 8BS3006.
//   - the actual substitution (optimize.mjs's optimizeStatement, tested
//     directly against a hand-built IR, the way ir-optimize.test.mjs
//     tests every other rewrite in that file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { link } from '../index.mjs';
import { optimizeIr } from '../src/linker/optimize.mjs';
import { build } from '../src/mos/index.ts';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';

const codes = (diagnostics) => diagnostics.map((d) => d.code);
const program = (body) => `export function main(): void {\n${body}\n}\n`;

test('a plain counted @unroll loop compiles clean', () => {
  const src = program(
    '    let sum: utinyint = 0;\n'
    + '    @unroll\n'
    + '    for (let i: utinyint = 0; i < 4; i++) {\n'
    + '        sum = sum + 1;\n'
    + '    }\n',
  );
  const { diagnostics } = link(src, '/x/main.8bs', { machine: 'c64' });
  assert.deepEqual(codes(diagnostics), []);
});

test('@unroll on a loop that does not start at 0, or whose bound is not a compile-time value, is 8BS3006', () => {
  const notFromZero = program('    @unroll\n    for (let i: utinyint = 1; i < 4; i++) {\n    }\n');
  const { diagnostics: a } = link(notFromZero, '/x/main.8bs', { machine: 'c64' });
  assert.deepEqual(codes(a), ['8BS3006']);
  assert.match(a[0].message, /plain counted loop/);

  const runtimeBound = 'let n: utinyint = 4;\n' + program('    @unroll\n    for (let i: utinyint = 0; i < n; i++) {\n    }\n');
  const { diagnostics: b } = link(runtimeBound, '/x/main.8bs', { machine: 'c64' });
  assert.deepEqual(codes(b), ['8BS3006']);
});

test('@unroll on a loop past UNROLL_DECORATOR_MAX iterations is refused by name, not silently capped', () => {
  const src = program('    @unroll\n    for (let i: usmallint = 0; i < 5000; i++) {\n    }\n');
  const { diagnostics } = link(src, '/x/main.8bs', { machine: 'c64' });
  assert.deepEqual(codes(diagnostics), ['8BS3006']);
  assert.match(diagnostics[0].message, /5000 times, past the 4096/);
});

test('@unroll on a loop whose body breaks or continues is refused: the jump has nowhere to go once the loop is gone', () => {
  const withBreak = program(
    '    let hit: utinyint = 0;\n'
    + '    @unroll\n'
    + '    for (let i: utinyint = 0; i < 4; i++) {\n'
    + '        if (i == 2) { break; }\n'
    + '        hit = i;\n'
    + '    }\n',
  );
  const { diagnostics } = link(withBreak, '/x/main.8bs', { machine: 'c64' });
  assert.deepEqual(codes(diagnostics), ['8BS3006']);
  assert.match(diagnostics[0].message, /breaks or continues/);
});

test('@unroll takes no arguments and applies to nothing but a for loop', () => {
  const withArg = program('    @unroll(8)\n    for (let i: utinyint = 0; i < 4; i++) {\n    }\n');
  assert.deepEqual(codes(link(withArg, '/x/main.8bs', { machine: 'c64' }).diagnostics), ['8BS3001']);

  const onWhile = program('    let i: utinyint = 0;\n    @unroll\n    while (i < 4) {\n        i = i + 1;\n    }\n');
  assert.deepEqual(codes(link(onWhile, '/x/main.8bs', { machine: 'c64' }).diagnostics), ['8BS3001']);

  const wrongName = program('    @loop\n    for (let i: utinyint = 0; i < 4; i++) {\n    }\n');
  const { diagnostics } = link(wrongName, '/x/main.8bs', { machine: 'c64' });
  assert.deepEqual(codes(diagnostics), ['8BS3001']);
  assert.match(diagnostics[0].message, /@loop is not a loop decorator/);
});

test('a project const or #fact folded to a small positive count still unrolls (the common case a demoscene loop actually writes)', () => {
  const src = 'const N: utinyint = 6;\n' + program(
    '    let sum: utinyint = 0;\n'
    + '    @unroll\n'
    + '    for (let i: utinyint = 0; i < N; i++) {\n'
    + '        sum = sum + i;\n'
    + '    }\n',
  );
  const { diagnostics } = link(src, '/x/main.8bs', { machine: 'c64' });
  assert.deepEqual(codes(diagnostics), []);
});

// ---- the substitution itself (optimize.mjs), against a hand-built IR ------

const constNum = (value, type = 'utinyint') => ({ kind: 'const', value, type });
const ref = (name, type = 'utinyint') => ({ kind: 'ref', name, type });
const bin = (operator, left, right, type = 'bool') => ({ kind: 'binop', operator, left, right, type });
const assign = (target, value) => ({ kind: 'assign', target, value });

function unrollFor(count, body) {
  return {
    kind: 'for',
    unroll: true,
    init: { kind: 'local', name: 'i', type: 'utinyint', init: constNum(0) },
    test: bin('<', ref('i'), constNum(count)),
    update: { kind: 'assign', target: 'i', value: bin('+', ref('i'), constNum(1), 'utinyint') },
    body,
  };
}

test('optimizeIr substitutes an @unroll loop N times, i replaced by its constant each time — no body needs a string byte', () => {
  const ir = {
    entry: 'main',
    functions: [{
      name: 'main',
      body: [unrollFor(3, [assign('hit', ref('i'))])],
    }],
    globals: [],
  };
  const out = optimizeIr(ir);
  assert.deepEqual(out.functions[0].body, [
    assign('hit', constNum(0)),
    assign('hit', constNum(1)),
    assign('hit', constNum(2)),
  ]);
});

test('a for loop with no @unroll and a non-string-copy body is left as a loop, not substituted', () => {
  const ir = {
    entry: 'main',
    functions: [{
      name: 'main',
      body: [{ ...unrollFor(3, [assign('hit', ref('i'))]), unroll: false }],
    }],
    globals: [],
  };
  const out = optimizeIr(ir);
  assert.equal(out.functions[0].body.length, 1);
  assert.equal(out.functions[0].body[0].kind, 'for');
});

// ---- 8bs build --remarks: what @unroll did, surfaced end to end ----------

test('build({ remarks: true }) returns an 8BS9001 remark naming the unroll count; without the option, none is returned', async () => {
  const src = program(
    '    let sum: utinyint = 0;\n'
    + '    @unroll\n'
    + '    for (let i: utinyint = 0; i < 4; i++) {\n'
    + '        sum = sum + i;\n'
    + '    }\n',
  );
  const entry = '/x/main.8bs';
  const { ir, diagnostics } = link(src, entry, { machine: 'pet' });
  assert.deepEqual(codes(diagnostics), []);
  assert.ok(ir);

  const resolved = resolveHardware(loadCatalog('pet'));
  assert.ok(resolved.ok);
  const scratch = await mkdtemp(join(tmpdir(), '8bs-remarks-'));
  try {
    const plain = await build(ir, {
      machine: 'pet', hardware: resolved.hardware, outFile: join(scratch, 'out.prg'), frameRate: 60,
    });
    assert.equal(plain.ok, true, plain.ok ? '' : plain.error);
    assert.equal(plain.remarks, undefined, 'no --remarks, none returned — the same pay-only-if-used rule sizeReport follows');

    const withRemarks = await build(ir, {
      machine: 'pet', hardware: resolved.hardware, outFile: join(scratch, 'out.prg'), frameRate: 60, remarks: true,
    });
    assert.equal(withRemarks.ok, true, withRemarks.ok ? '' : withRemarks.error);
    assert.equal(withRemarks.remarks.length, 1);
    const [remark] = withRemarks.remarks;
    assert.equal(remark.code, '8BS9001');
    assert.equal(remark.severity, 'remark');
    assert.equal(remark.file, entry);
    assert.match(remark.message, /4 copies/);
    assert.match(remark.message, /in main/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
