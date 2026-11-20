// `namespace` declarations: compile-time-only qualification for library
// surfaces like `screen.setBorderColor(...)` and `BorderColor.BLUE`. See
// docs/compiler.md and packages/vic20/src/index.8bs for the real thing this
// exists to support.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  tokenize, parse, lower, link, NodeType,
} from '../index.mjs';

const lowered = (src) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  return lower(ast, 't');
};

// ---- parsing ----------------------------------------------------------

test('a namespace of functions and consts parses', () => {
  const src = `
pub mod screen {
    fn setBorderColor(color: utinyint) {
        memory::write(0x900F, color);
    }
}
pub mod BorderColor {
    const BLUE: utinyint = 6;
}
`;
  const { ast, diagnostics } = parse(tokenize(src, 't').tokens, src, 't');
  assert.deepEqual(diagnostics, []);
  assert.equal(ast.body[0].type, NodeType.NamespaceDeclaration);
  assert.equal(ast.body[0].name.name, 'screen');
  assert.equal(ast.body[0].exported, true);
  assert.equal(ast.body[1].members[0].name.name, 'BLUE');
});

// ---- lowering: members mangle, consts never become storage --------------

test('a namespace function lowers to a mangled top-level function', () => {
  const { ir, diagnostics } = lowered(
    'pub mod screen {\n    fn setBorderColor(color: utinyint) {\n        memory::write(0x900F, color);\n    }\n}\n',
  );
  assert.equal(diagnostics.length, 0);
  assert.equal(ir.functions[0].name, 'screen_setBorderColor');
  assert.equal(ir.functions[0].exported, false); // reachable only via the namespace
  assert.deepEqual(ir.namespaces[0], {
    name: 'screen',
    exported: true,
    functions: new Map([['setBorderColor', 'screen_setBorderColor']]),
    consts: new Map(),
    constTypes: new Map(), // each numeric const's declared type, for the linker's inlining
    start: 8, length: 6, // the name's span, for the linker's entry-export rule
  });
});

test('a namespace const is recorded as a value, never emitted as a global', () => {
  const { ir, diagnostics } = lowered('pub mod BorderColor {\n    const BLUE: utinyint = 6;\n}\n');
  assert.equal(diagnostics.length, 0);
  assert.equal(ir.globals.length, 0);
  assert.equal(ir.functions.length, 0);
  assert.deepEqual(ir.namespaces[0].consts, new Map([['BLUE', 6]]));
});

test('a namespace member must be const, not let', () => {
  const { diagnostics } = lowered('mod X {\n    let y: utinyint = 1;\n}\n');
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3001']);
});

test('a namespace const needs a literal initializer', () => {
  const { diagnostics } = lowered('mod X {\n    const y: utinyint = 1 + 1;\n}\n');
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3001']);
});

test('a call inside the same module resolves against its own namespace', () => {
  const src = [
    'mod screen {',
    '    fn setBorderColor(color: utinyint) {',
    '        memory::write(0x900F, color);',
    '    }',
    '}',
    'pub fn main() {',
    '    screen::setBorderColor(6);',
    '}',
  ].join('\n');
  const { ir, diagnostics } = link(src, 't.8bs');
  assert.deepEqual(diagnostics, []);
  const main = ir.functions.find((f) => f.name === 'main');
  assert.equal(main.body[0].kind, 'call');
  assert.equal(main.body[0].name, 'screen_setBorderColor');
});

test('a namespace const inlines to its literal value wherever it is used', () => {
  const src = [
    'mod BorderColor {',
    'const BLUE: utinyint = 6;',
    '}',
    'pub fn main() {',
    '    memory::write(0x900F, BorderColor::BLUE);',
    '}',
  ].join('\n');
  const { ir, diagnostics } = link(src, 't.8bs');
  assert.deepEqual(diagnostics, []);
  const main = ir.functions.find((f) => f.name === 'main');
  assert.deepEqual(main.body[0].value, { kind: 'const', type: 'utinyint', value: 6 });
});

// ---- linking: unresolved namespaces and members are honest errors --------

test('calling a namespace that does not exist is an unresolved name', () => {
  const { ir, diagnostics } = link('pub fn main() {\n    nope::go();\n}', 't.8bs');
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2007']);
});

test('calling a member a namespace does not have is 8BS2005-shaped', () => {
  const src = [
    'mod screen {',
    '    fn setBorderColor(color: utinyint) {',
    '        memory::write(0x900F, color);',
    '    }',
    '}',
    'pub fn main() {',
    '    screen::setBackgroundColor(1);',
    '}',
  ].join('\n');
  const { ir, diagnostics } = link(src, 't.8bs');
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2005']);
});

test('a namespace that exists but was not exported cannot be imported', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-ns-test-'));
  try {
    // No `export` on the namespace: it exists in lib.8bs but is private to it.
    writeFileSync(join(dir, 'lib.8bs'), 'mod screen {\n    fn f() {\n        return;\n    }\n}\n');
    const entry = 'use self::lib::screen;\npub fn main() {\n    screen::f();\n}\n';
    const { ir, diagnostics } = link(entry, join(dir, 'main.8bs'));
    assert.equal(ir, null);
    assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2005']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- real cross-module linking, the way a package actually gets used ----

test('an exported namespace works when imported from another module', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-ns-test-'));
  try {
    const lib = [
      'pub mod screen {',
      '    fn setBorderColor(color: utinyint) {',
      '        memory::write(0x900F, memory::read(0x900F) & 0xF8 | color & 0x07);',
      '    }',
      '}',
      'pub mod BorderColor {',
      '    const BLUE: utinyint = 6;',
      '}',
    ].join('\n');
    const main = [
      'use self::lib::{screen, BorderColor};',
      'pub fn main() {',
      '    screen::setBorderColor(BorderColor::BLUE);',
      '}',
    ].join('\n');
    writeFileSync(join(dir, 'lib.8bs'), lib);
    writeFileSync(join(dir, 'main.8bs'), main);

    const { ir, diagnostics } = link(main, join(dir, 'main.8bs'));
    assert.deepEqual(diagnostics, []);
    assert.ok(ir.functions.some((f) => f.name === 'screen_setBorderColor'));
    const entry = ir.functions.find((f) => f.name === 'main');
    assert.equal(entry.body[0].kind, 'call');
    assert.equal(entry.body[0].name, 'screen_setBorderColor');
    assert.deepEqual(entry.body[0].args[0], { kind: 'const', type: 'utinyint', value: 6 });

    const setBorder = ir.functions.find((f) => f.name === 'screen_setBorderColor');
    assert.deepEqual(setBorder.params, [{ name: 'color', type: 'utinyint' }]);
    const write = setBorder.body[0];
    assert.equal(write.kind, 'memoryWrite');
    assert.deepEqual(write.address, { kind: 'const', value: 36879, type: 'usmallint' });
    assert.equal(write.value.operator, '|');
    assert.equal(write.value.left.operator, '&');
    assert.equal(write.value.left.left.kind, 'memoryRead');
    assert.deepEqual(write.value.left.left.address, { kind: 'const', value: 36879, type: 'usmallint' });
    assert.deepEqual(write.value.left.right, { kind: 'const', value: 248, type: 'utinyint' });
    assert.equal(write.value.right.operator, '&');
    assert.equal(write.value.right.left.name, 'color');
    assert.deepEqual(write.value.right.right, { kind: 'const', value: 7, type: 'utinyint' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
