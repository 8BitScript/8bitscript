// F-01: the pieces of the flip that work on the new syntax before the
// compiler switches parsers: E20 (assigning to a plain `let`), `use` token
// runs in `findImports`, and the resolver's extension search (8BS2217).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { check } from '../src/checker/index.mjs';
import {
  findImports, pathFormSpecifiers, resolveImports, resolveSpecifier, withPathForm,
} from '../src/resolver/index.mjs';
import { resolveModuleFile, resolvePortableModule } from '../src/intellisense/symbols.mjs';
import { parse, tokenize } from '../src/front/index.mjs';
import { link } from '../index.mjs';

const E20 = (src) => {
  const { tokens } = tokenize(src, 't.8bs');
  const { ast, diagnostics } = parse(tokens, src, 't.8bs');
  assert.deepEqual(diagnostics, [], src);
  return check(ast, 't.8bs', src).filter((d) => d.code === '8BS1031').map((d) => d.message);
};
const msg = (name) => `'${name}' is declared with let, not let mut, and cannot be assigned`;

test('E20: assigning, updating or indexing a plain let is 8BS1031 at the name', () => {
  assert.deepEqual(E20('let x: u8 = 0;\npub fn main() { x = 1; }'), [msg('x')]);
  assert.deepEqual(E20('let x: u8 = 0;\npub fn main() { x += 1; }'), [msg('x')]);
  assert.deepEqual(E20('let a: array<u8, 4>;\npub fn main() { a[1] = 2; }'), [msg('a')]);
  assert.deepEqual(E20('pub fn main() { let y: u8 = 0; y = 3; }'), [msg('y')]);
});

test('E20: let mut and reads are fine', () => {
  assert.deepEqual(E20('let mut x: u8 = 0;\npub fn main() { x = 1; x += 1; }'), []);
  assert.deepEqual(E20('let x: u8 = 0;\npub fn main() { let z: u8 = x; }'), []);
});

test('E20: names resolve by block scope, not per function', () => {
  // The inner `let mut x` shadows; the outer plain `x` is untouched.
  assert.deepEqual(E20('pub fn main() { let x: u8 = 0; if true { let mut x: u8 = 1; x = 2; } }'), []);
  // After the block ends, `x` is the outer plain one again.
  assert.deepEqual(
    E20('pub fn main() { let x: u8 = 0; if true { let mut x: u8 = 1; x = 2; } x = 3; }'),
    [msg('x')],
  );
  // A plain `let` in an inner block is not seen outside it.
  assert.deepEqual(E20('let mut x: u8 = 0;\npub fn main() { if true { let x: u8 = 1; } x = 2; }'), []);
  // A parameter shadows a module-level plain let.
  assert.deepEqual(E20('let x: u8 = 0;\nfn f(x: u8) { x = 1; }'), []);
});

test('E20: a mod member is reached through its namespace', () => {
  assert.deepEqual(E20('mod m { pub let x: u8 = 0; }\npub fn main() { m::x = 1; }'), [msg('x')]);
  assert.deepEqual(E20('mod m { pub let mut x: u8 = 0; }\npub fn main() { m::x = 1; }'), []);
});

test('E20: a range for steps its own variable; assigning it in the body is still an error', () => {
  assert.deepEqual(E20('pub fn main() { for i in 0..4 { let mut n: u8 = i; n = 1; } }'), []);
  assert.deepEqual(E20('pub fn main() { for i in 0..=4 { i = 3; } }'), [msg('i')]);
  assert.deepEqual(E20('pub fn main() { for (let mut i: u8 = 0; i < 4; i += 1) { } }'), []);
});

test('E20: a C-style for with a plain let is reported; with let mut it is not', () => {
  assert.deepEqual(E20('pub fn main() { for (let i: u8 = 0; i < 4; i += 1) { } }'), [msg('i')]);
  assert.deepEqual(E20('pub fn main() { for (let mut i: u8 = 0; i < 4; i += 1) { } }'), []);
});

test('E20: ++ and -- on a plain let, in a statement or a C-style update, are reported', () => {
  const id = (name, start) => ({ type: 'Identifier', name, start, length: 1 });
  const decl = (immutable, start = 0) => ({
    type: 'VariableDeclaration', kind: 'let', immutable, start, length: 10, name: id('x', start + 4),
  });
  const update = (operator) => ({ type: 'UpdateExpression', operator, prefix: false, argument: id('x', 20) });
  for (const operator of ['++', '--']) {
    const stmt = { type: 'Program', body: [decl(true),
      { type: 'ExpressionStatement', expression: update(operator) }] };
    assert.deepEqual(check(stmt, 't.8bs').map((d) => d.message), [msg('x')], operator);
    // a C-style init starts at `let`, so its own update is not the range step
    const cFor = { type: 'Program', body: [{ type: 'ForStatement', init: decl(true), update: update(operator),
      test: null, body: { type: 'BlockStatement', body: [] } }] };
    assert.deepEqual(check(cFor, 't.8bs').map((d) => d.message), [msg('x')], operator);
    // the range form (init starts at the variable) steps its own variable
    const range = { type: 'Program', body: [{ type: 'ForStatement', init: { ...decl(true), start: 4, name: id('x', 4) },
      update: update('++'), test: null, body: { type: 'BlockStatement', body: [] } }] };
    assert.deepEqual(check(range, 't.8bs').map((d) => d.message), [], 'range');
  }
});

test('E20: a let named in an asm6502 body is not a user store, and an import is not a local let', () => {
  assert.deepEqual(E20('let x: u8 = 0;\npub fn main() { asm6502 { lda x } }'), []);
  // The exporting module declares `pub let mut`; an importer's store is not seen here.
  assert.deepEqual(E20('use self::a::{x};\npub fn main() { x = 1; }'), []);
});

test('E20: an old-syntax tree is never reported', () => {
  const src = 'let x: u8 = 0;\nexport function main(): void { x = 1; }';
  // The old parser does not set `immutable`.
  const ast = { type: 'Program', body: [
    { type: 'VariableDeclaration', kind: 'let', name: { type: 'Identifier', name: 'x', start: 4, length: 1 } },
    { type: 'ExpressionStatement', expression: { type: 'AssignmentExpression', operator: '=',
      left: { type: 'Identifier', name: 'x', start: 40, length: 1 }, right: { type: 'IntegerLiteral', value: 1 } } },
  ] };
  assert.deepEqual(check(ast, 't.8bs', src).filter((d) => d.code === '8BS1031'), []);
});

const imports = (src) => findImports(tokenize(src, 't.8bs').tokens);
const specifiers = (src) => imports(src).map((i) => i.specifier);

test('findImports reads use runs with the parser head mapping', () => {
  assert.deepEqual(specifiers('use self::geo::{a, b};'), ['./geo']);
  assert.deepEqual(specifiers('use self::geo::a;'), ['./geo']);
  assert.deepEqual(specifiers('use super::super::util::math::{a};'), ['../../util/math']);
  assert.deepEqual(specifiers('use @lib::rules::{SCORE};'), ['@lib/rules']);
  assert.deepEqual(specifiers('use text::{print};'), ['text']);
  assert.deepEqual(specifiers('use "./hardware.8bs"::{a};'), ['./hardware.8bs']);
  assert.deepEqual(specifiers('use "@8bitscript/c64/raster"::name;'), ['@8bitscript/c64/raster']);
  assert.deepEqual(specifiers('use self::geo::a as b;\nuse self::other::{c};'), ['./geo', './other']);
});

test('findImports: the span covers the module path, and a malformed run is skipped', () => {
  const src = 'use self::geo::{a};';
  assert.deepEqual(imports(src).map((i) => src.slice(i.start, i.start + i.length)), ['self::geo']);
  assert.deepEqual(specifiers('use foo;'), []);
  assert.deepEqual(specifiers('use self::{a};'), []);
});

test('findImports equals the parsed import sources', () => {
  const src = [
    'use self::geo::{a, b};',
    'use super::x::c;',
    'use @lib::deep::mod2::{d};',
    'use "./raw.8bs"::{e};',
    'use text::{print};',
    '',
  ].join('\n');
  const { tokens } = tokenize(src, 't.8bs');
  const { ast } = parse(tokens, src, 't.8bs');
  const sources = ast.body.filter((n) => n.type === 'ImportDeclaration').map((n) => n.source.value);
  assert.deepEqual(findImports(tokens).map((i) => i.specifier), sources);
});

const PATH = { pathForm: true };
const tree = (files) => {
  const root = mkdtempSync(join(tmpdir(), '8bs-flip-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
};

test('resolver: a path-form specifier searches the source extensions', () => {
  const root = tree({ 'main.8bs': '', 'geo.8bs': '', 'ui.8bx': '', 'art.8bg': '', 'song.8ba': '' });
  const from = join(root, 'main.8bs');
  assert.equal(resolveSpecifier('./geo', from, PATH).path, join(root, 'geo.8bs'));
  assert.equal(resolveSpecifier('./ui', from, PATH).path, join(root, 'ui.8bx'));
  assert.equal(resolveSpecifier('./art', from, PATH).path, join(root, 'art.8bg'));
  assert.equal(resolveSpecifier('./song', from, PATH).path, join(root, 'song.8ba'));
  assert.equal(resolveSpecifier('./geo.8bs', from).path, join(root, 'geo.8bs'));
});

test('resolver: none found is 8BS2004, two or more is 8BS2217', () => {
  const root = tree({ 'main.8bs': '', 'both.8bs': '', 'both.8bx': '' });
  const from = join(root, 'main.8bs');
  assert.equal(resolveSpecifier('./nope', from, PATH).code, '8BS2004');
  const two = resolveSpecifier('./both', from, PATH);
  assert.equal(two.code, '8BS2217');
  assert.match(two.message, /both\.8bs, both\.8bx/);
  // The string form with the extension chooses.
  assert.equal(resolveSpecifier('./both.8bx', from).path, join(root, 'both.8bx'));
});

test('resolver: names that differ only in case are ambiguous on every file system', () => {
  const root = tree({ 'main.8bs': '', 'Mark.8bx': '', 'mark.8bg': '' });
  const found = resolveSpecifier('./mark', join(root, 'main.8bs'), PATH);
  assert.equal(found.code, '8BS2217');
  assert.match(found.message, /mark\.8bx, mark\.8bg/);
  const twins = tree({ 'main.8bs': '', 'Twin.c64.8bs': '', 'twin.8bx': '' });
  const twin = resolveSpecifier('./twin', join(twins, 'main.8bs'), { ...PATH, machine: 'c64' });
  assert.equal(twin.code, '8BS2217');
  assert.match(twin.message, /twin\.8bs, twin\.8bx/);
  const one = tree({ 'main.8bs': '', 'Geo.8bs': '' });
  assert.notEqual(resolveSpecifier('./geo', join(one, 'main.8bs'), PATH)?.code, '8BS2217');
});

test('resolver: a specifier that is not a module name is left alone', () => {
  const root = tree({ 'main.8bs': '' });
  assert.equal(resolveSpecifier('./data.json', join(root, 'main.8bs')), null);
});

test('resolver: alias path form searches too, and resolveImports reports on the path span', () => {
  const root = tree({ 'src/lib/rules.8bs': '', 'src/main.8bs': '' });
  const importAliases = { '@lib': join(root, 'src', 'lib') };
  assert.equal(
    resolveSpecifier('@lib/rules', join(root, 'src', 'main.8bs'), { importAliases, pathForm: true }).path,
    join(root, 'src', 'lib', 'rules.8bs'),
  );
  const src = 'use self::missing::{a};';
  const file = join(root, 'src', 'main.8bs');
  const { tokens } = tokenize(src, file);
  const found = resolveImports(tokens, file);
  assert.deepEqual(found.map((d) => d.code), ['8BS2004']);
  assert.equal(src.slice(found[0].start, found[0].start + found[0].length), 'self::missing');
});

test('old import syntax is the old-syntax error (E21), not a resolved import', () => {
  const root = tree({ 'src/main.8bs': '', 'src/geo.8bs': '' });
  const from = join(root, 'src', 'main.8bs');
  assert.equal(resolveSpecifier('./geo', from), null);
  const oldText = 'import { f } from "./geo";\nexport function main(): void { f(); }\n';
  const { diagnostics } = link(oldText, from);
  assert.ok(diagnostics.some((d) => /8bs migrate/.test(d.message)), JSON.stringify(diagnostics.map((d) => d.code)));
});

test('pathFormSpecifiers and withPathForm: only a use run is a path form', () => {
  const tokens = tokenize('use self::geo::{ x };\nimport { y } from "./old.8bs";\n', 't.8bs').tokens;
  assert.deepEqual([...pathFormSpecifiers(tokens)], ['./geo']);
  assert.equal(withPathForm({ machine: 'c64' }, true).pathForm, true);
  assert.deepEqual(withPathForm({ machine: 'c64' }, false), { machine: 'c64' });
});

test('resolveModuleFile and resolvePortableModule: pathForm finds the extension, its absence does not', () => {
  const root = tree({ 'main.8bs': '', 'geo.8bs': '' });
  const from = join(root, 'main.8bs');
  assert.equal(resolveModuleFile('./geo', from, { pathForm: true })?.path, join(root, 'geo.8bs'));
  assert.equal(resolveModuleFile('./geo', from, {}), null);
  assert.equal(resolvePortableModule('./geo', from, { pathForm: true })?.path, join(root, 'geo.8bs'));
  assert.equal(resolvePortableModule('./geo', from, {}), null);
});

test('ir: an import record keeps the parser usePath as pathForm', async () => {
  const { lower } = await import('../src/ir/index.mjs');
  const source = { type: 'Literal', value: './geo' };
  const node = (usePath) => ({ type: 'ImportDeclaration', source, specifiers: [], start: 0, length: 1, ...(usePath ? { usePath } : {}) });
  const record = (n) => {
    const ir = lower({ type: 'Program', body: [n], start: 0, length: 1 }, 't.8bs', '');
    return ir.imports?.[0] ?? ir.ir?.imports?.[0];
  };
  assert.equal(record(node(true))?.pathForm, true);
  assert.equal(record(node(false))?.pathForm, undefined);
});
