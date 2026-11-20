// A namespace const takes the same initializers a module-level const does:
// a literal, or a const — its own module's, another namespace's member, or
// an import — resolved by the linker, range-checked against the member's
// type, and inlined wherever the member is used. This is what lets a
// package's geometry live in one small file and its surface read it:
// `namespace text { const COLUMNS: utinyint = Video.COLUMNS; }`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { link, tokenize, parse, lower } from '../index.mjs';

const lowered = (src) => {
  const { tokens } = tokenize(src, 't.8bs');
  const { ast } = parse(tokens, src, 't.8bs');
  return lower(ast, 't.8bs', src);
};
const codes = (diagnostics) => diagnostics.map((d) => d.code);
const mainOf = (ir) => ir.functions.find((f) => f.name === 'main');

test('lowering: a namespace const from a const it cannot see yet is recorded pending, with its type', () => {
  const { ir, diagnostics } = lowered('mod Video {\n    const COLUMNS: utinyint = Geometry::COLUMNS;\n    const ROWS: utinyint = ROW_COUNT;\n}\n');
  assert.deepEqual(diagnostics, []);
  const consts = ir.namespaces[0].consts;
  assert.equal(consts.get('COLUMNS').pending.kind, 'namespaceConst');
  assert.equal(consts.get('ROWS').pending.kind, 'ref');
  assert.equal(consts.get('COLUMNS').type, 'utinyint');
});

test('lowering: a namespace const from a name this module declares as storage, or from an expression, is refused', () => {
  const storage = lowered('let width: utinyint = 40;\nmod Video {\n    const COLUMNS: utinyint = width;\n}\n');
  assert.deepEqual(codes(storage.diagnostics), ['8BS3001']);
  assert.match(storage.diagnostics[0].message, /'width' is not a const/);
  const expression = lowered('mod Video {\n    const COLUMNS: utinyint = 20 + 20;\n}\n');
  assert.deepEqual(codes(expression.diagnostics), ['8BS3001']);
  assert.match(expression.diagnostics[0].message, /a literal or a const/);
});

test('linker: a namespace const from an own const, and from another namespace\'s member, inlines as the value', () => {
  const src = [
    'const WIDTH: utinyint = 40;',
    'mod Video {',
    'const COLUMNS: utinyint = WIDTH;',
    'const ROWS: utinyint = 25;',
    '}',
    'mod text {',
    '    const COLUMNS: utinyint = Video::COLUMNS;',
    '    const LAST_ROW: utinyint = Video::ROWS;',
    '}',
    'pub fn main() {',
    '    memory::write(0x8000, text::COLUMNS);',
    '    memory::write(0x8001, text::LAST_ROW);',
    '}',
  ].join('\n');
  const { ir, diagnostics } = link(src, 't.8bs');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(mainOf(ir).body[0].value, { kind: 'const', type: 'utinyint', value: 40 });
  assert.deepEqual(mainOf(ir).body[1].value, { kind: 'const', type: 'utinyint', value: 25 });
});

test('linker: a chain of pending namespace consts across modules resolves, and a cycle is reported once per member, not looped on', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-ns-consts-'));
  try {
    await writeFile(join(dir, 'geometry.8bs'), 'pub mod Video {\n    const COLUMNS: utinyint = 80;\n    const CELL_COUNT: usmallint = 2000;\n}\n');
    await writeFile(join(dir, 'lib.8bs'), [
      'use self::geometry::Video;',
      'pub mod text {',
      '    const COLUMNS: utinyint = Video::COLUMNS;',
      '    const CELL_COUNT: usmallint = Video::CELL_COUNT;',
      '    fn fill() {',
      '        for cell: usmallint in 0..text::CELL_COUNT {',
      '            memory::write(0x8000 + cell, 32);',
      '        }',
      '    }',
      '}',
    ].join('\n'));
    const main = 'use self::lib::text;\npub fn main() {\n    text::fill();\n    memory::write(0x8000 + text::COLUMNS, text::COLUMNS);\n}\n';
    await writeFile(join(dir, 'main.8bs'), main);
    const { ir, diagnostics } = link(main, join(dir, 'main.8bs'));
    assert.deepEqual(diagnostics, []);
    const fill = ir.functions.find((f) => f.name === 'text_fill');
    assert.deepEqual(fill.body[0].test.right, { kind: 'const', type: 'usmallint', value: 2000 });
    const write = mainOf(ir).body[1];
    assert.deepEqual(write.address, { kind: 'binop', operator: '+', left: { kind: 'const', value: 32768, type: 'usmallint' }, right: { kind: 'const', type: 'utinyint', value: 80 }, type: 'usmallint' });
    assert.deepEqual(write.value, { kind: 'const', type: 'utinyint', value: 80 });

    await writeFile(join(dir, 'a.8bs'), 'use self::b::B;\npub mod A {\n    const X: utinyint = B::Y;\n}\n');
    await writeFile(join(dir, 'b.8bs'), 'use self::a::A;\npub mod B {\n    const Y: utinyint = A::X;\n}\n');
    const cyclic = 'use self::a::A;\npub fn main() {\n    memory::write(0x8000, A::X);\n}\n';
    await writeFile(join(dir, 'cycle.8bs'), cyclic);
    const cycle = link(cyclic, join(dir, 'cycle.8bs'));
    assert.deepEqual(codes(cycle.diagnostics), ['8BS3001', '8BS3001']);
    assert.match(cycle.diagnostics[0].message, /'A\.X' is a const whose value depends on itself/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('linker: a namespace const gets the range check of its own type, not of the const it copies', () => {
  const src = [
    'mod Wide {',
    'const COUNT: usmallint = 2000;',
    '}',
    'mod Narrow {',
    '    const COUNT: utinyint = Wide::COUNT;',
    '}',
    'pub fn main() {',
    '    memory::write(0x8000, Narrow::COUNT);',
    '}',
  ].join('\n');
  const { diagnostics } = link(src, 't.8bs');
  assert.deepEqual(codes(diagnostics), ['8BS1021']);
  assert.match(diagnostics[0].message, /2000 does not fit in utinyint/);
});
