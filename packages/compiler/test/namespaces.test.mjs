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
export namespace screen {
    function setBorderColor(color: utinyint): void {
        memory.write(0x900F, color);
    }
}
export namespace BorderColor {
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
    'export namespace screen {\n    function setBorderColor(color: utinyint): void { memory.write(0x900F, color); }\n}\n',
  );
  assert.equal(diagnostics.length, 0);
  assert.equal(ir.functions[0].name, 'screen_setBorderColor');
  assert.equal(ir.functions[0].exported, false); // reachable only via the namespace
  assert.deepEqual(ir.namespaces[0], {
    name: 'screen',
    exported: true,
    functions: new Map([['setBorderColor', 'screen_setBorderColor']]),
    consts: new Map(),
    start: 17, length: 6, // the name's span, for the linker's entry-export rule
  });
});

test('a namespace const is recorded as a value, never emitted as a global', () => {
  const { ir, diagnostics } = lowered('export namespace BorderColor {\n    const BLUE: utinyint = 6;\n}\n');
  assert.equal(diagnostics.length, 0);
  assert.equal(ir.globals.length, 0);
  assert.equal(ir.functions.length, 0);
  assert.deepEqual(ir.namespaces[0].consts, new Map([['BLUE', 6]]));
});

test('a namespace member must be const, not let', () => {
  const { diagnostics } = lowered('namespace X {\n    let y: utinyint = 1;\n}\n');
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3001']);
});

test('a namespace const needs a literal initialiser', () => {
  const { diagnostics } = lowered('namespace X {\n    const y: utinyint = 1 + 1;\n}\n');
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS3001']);
});

test('a call inside the same module resolves against its own namespace', () => {
  const src = [
    'namespace screen {',
    '    function setBorderColor(color: utinyint): void { memory.write(0x900F, color); }',
    '}',
    'export function main(): void { screen.setBorderColor(6); }',
  ].join('\n');
  const { ir, diagnostics } = link(src, 't.8bs');
  assert.deepEqual(diagnostics, []);
  const main = ir.functions.find((f) => f.name === 'main');
  assert.equal(main.body[0].kind, 'call');
  assert.equal(main.body[0].name, 'screen_setBorderColor');
});

test('a namespace const inlines to its literal value wherever it is used', () => {
  const src = [
    'namespace BorderColor {',
    '    const BLUE: utinyint = 6;',
    '}',
    'export function main(): void { memory.write(0x900F, BorderColor.BLUE); }',
  ].join('\n');
  const { ir, diagnostics } = link(src, 't.8bs');
  assert.deepEqual(diagnostics, []);
  const main = ir.functions.find((f) => f.name === 'main');
  assert.deepEqual(main.body[0].value, { kind: 'const', value: 6 });
});

// ---- linking: unresolved namespaces and members are honest errors --------

test('calling a namespace that does not exist is an unresolved name', () => {
  const { ir, diagnostics } = link('export function main(): void { nope.go(); }', 't.8bs');
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2007']);
});

test('calling a member a namespace does not have is 8BS2005-shaped', () => {
  const src = [
    'namespace screen {',
    '    function setBorderColor(color: utinyint): void { memory.write(0x900F, color); }',
    '}',
    'export function main(): void { screen.setBackgroundColor(1); }',
  ].join('\n');
  const { ir, diagnostics } = link(src, 't.8bs');
  assert.equal(ir, null);
  assert.deepEqual(diagnostics.map((d) => d.code), ['8BS2005']);
});

test('a namespace that exists but was not exported cannot be imported', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-ns-test-'));
  try {
    // No `export` on the namespace: it exists in lib.8bs but is private to it.
    writeFileSync(join(dir, 'lib.8bs'), 'namespace screen {\n    function f(): void { return; }\n}\n');
    const entry = 'import { screen } from "./lib.8bs";\nexport function main(): void { screen.f(); }\n';
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
      'export namespace screen {',
      '    function setBorderColor(color: utinyint): void {',
      '        memory.write(0x900F, (memory.read(0x900F) & 0xF8) | (color & 0x07));',
      '    }',
      '}',
      'export namespace BorderColor {',
      '    const BLUE: utinyint = 6;',
      '}',
    ].join('\n');
    const main = [
      'import { screen, BorderColor } from "./lib.8bs";',
      'export function main(): void {',
      '    screen.setBorderColor(BorderColor.BLUE);',
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
    assert.deepEqual(entry.body[0].args[0], { kind: 'const', value: 6 });

    const setBorder = ir.functions.find((f) => f.name === 'screen_setBorderColor');
    assert.deepEqual(setBorder.params, [{ name: 'color', type: 'utinyint' }]);
    const write = setBorder.body[0];
    assert.equal(write.kind, 'memoryWrite');
    assert.deepEqual(write.address, { kind: 'const', value: 36879 });
    assert.equal(write.value.operator, '|');
    assert.equal(write.value.left.operator, '&');
    assert.equal(write.value.left.left.kind, 'memoryRead');
    assert.deepEqual(write.value.left.left.address, { kind: 'const', value: 36879 });
    assert.deepEqual(write.value.left.right, { kind: 'const', value: 248 });
    assert.equal(write.value.right.operator, '&');
    assert.equal(write.value.right.left.name, 'color');
    assert.deepEqual(write.value.right.right, { kind: 'const', value: 7 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
