// Friendly primitive type names: the MySQL-inspired `tinyint`/`smallint`/
// `mediumint`/`int` family (and their `u`-prefixed unsigned counterparts),
// and the `i8`/`u8`-style low-level aliases they normalise to. See
// docs/compiler.md#primitive-integer-types.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze, tokenize, parse, lower } from '../index.mjs';
import { emitAssemblyScript } from '../../backend-web/src/index.mjs';
import { emitC } from '../../backend-6502/src/index.mjs';

const codes = (src) => analyze(src, 't.8bs').map((d) => d.code);
const clean = (src) => assert.deepEqual(codes(src), []);

const CANONICAL_NAMES = [
  'tinyint', 'utinyint', 'smallint', 'usmallint',
  'mediumint', 'umediumint', 'int', 'uint',
];
const LEGACY_ALIASES = ['i8', 'u8', 'i16', 'u16', 'i24', 'u24', 'i32', 'u32'];

// ---- parsing ----------------------------------------------------------

test('every canonical type name parses clean', () => {
  for (const name of CANONICAL_NAMES) clean(`let x: ${name} = 0;`);
});

test('every legacy alias still parses clean', () => {
  for (const name of LEGACY_ALIASES) clean(`let x: ${name} = 0;`);
});

test('the AST keeps whatever spelling was written', () => {
  const src = 'let x: utinyint = 10;';
  const { ast } = parse(tokenize(src, 't').tokens, src, 't');
  assert.equal(ast.body[0].typeAnnotation.name, 'utinyint');
});

// ---- range checking -----------------------------------------------------

const BOUNDS = {
  tinyint: [-128, 127], i8: [-128, 127],
  utinyint: [0, 255], u8: [0, 255],
  smallint: [-32768, 32767], i16: [-32768, 32767],
  usmallint: [0, 65535], u16: [0, 65535],
  mediumint: [-8388608, 8388607], i24: [-8388608, 8388607],
  umediumint: [0, 16777215], u24: [0, 16777215],
  int: [-2147483648, 2147483647], i32: [-2147483648, 2147483647],
  uint: [0, 4294967295], u32: [0, 4294967295],
};

test('every spelling accepts its exact boundaries', () => {
  for (const [name, [min, max]] of Object.entries(BOUNDS)) {
    clean(`let x: ${name} = ${min};`);
    clean(`let x: ${name} = ${max};`);
  }
});

test('every spelling rejects one past its boundaries', () => {
  for (const [name, [min, max]] of Object.entries(BOUNDS)) {
    assert.deepEqual(codes(`let x: ${name} = ${min - 1};`), ['8BS1021'], name);
    assert.deepEqual(codes(`let x: ${name} = ${max + 1};`), ['8BS1021'], name);
  }
});

test('the diagnostic keeps the spelling the programmer wrote', () => {
  let d = analyze('let x: utinyint = 300;', 't.8bs');
  assert.equal(d[0].message, '300 does not fit in utinyint (0..255)');

  d = analyze('let x: u8 = 300;', 't.8bs');
  assert.equal(d[0].message, '300 does not fit in u8 (0..255)');

  d = analyze('let x: int = 5000000000;', 't.8bs');
  assert.equal(d[0].message, '5000000000 does not fit in int (-2147483648..2147483647)');

  d = analyze('let x: uint = 5000000000;', 't.8bs');
  assert.equal(d[0].message, '5000000000 does not fit in uint (0..4294967295)');
});

test('a type constructor is still not an integer', () => {
  clean('let p: ptr<utinyint>;');
  clean('let a: array<utinyint, 300>;');
});

// ---- lowering: canonical and alias spellings are one type internally ----

const lowered = (src) => {
  const { tokens } = tokenize(src, 't');
  const { ast } = parse(tokens, src, 't');
  return lower(ast, 't');
};

test('the canonical names lower to the same id as their legacy alias', () => {
  const pairs = [
    ['tinyint', 'i8'], ['utinyint', 'u8'],
    ['smallint', 'i16'], ['usmallint', 'u16'],
    ['mediumint', 'i24'], ['umediumint', 'u24'],
    ['int', 'i32'], ['uint', 'u32'],
  ];
  for (const [canonical, alias] of pairs) {
    const a = lowered(`let x: ${canonical} = 0;`).ir.globals[0];
    const b = lowered(`let x: ${alias} = 0;`).ir.globals[0];
    assert.equal(a.type, canonical, canonical);
    assert.equal(a.type, b.type, `${canonical} vs ${alias}`);
  }
});

test('volatile<utinyint> lowers the same as volatile<u8>', () => {
  const a = lowered('@address(0x900F)\nlet v: volatile<utinyint>;').ir.globals[0];
  const b = lowered('@address(0x900F)\nlet v: volatile<u8>;').ir.globals[0];
  assert.deepEqual(a, b);
});

// Positions differ because "utinyint" and "u8" are different lengths in the
// source; everything that actually reaches the backends must not.
function stripSpans(value) {
  if (Array.isArray(value)) return value.map(stripSpans);
  if (value && typeof value === 'object') {
    const { start, length, ...rest } = value;
    return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, stripSpans(v)]));
  }
  return value;
}

test('the utinyint milestone example lowers exactly like the u8 one', () => {
  const src = (t) => `let x: ${t} = 10;\nexport function main(): void { x = x + 1; }`;
  const canonical = lowered(src('utinyint'));
  const legacy = lowered(src('u8'));
  assert.equal(canonical.diagnostics.length, 0);
  assert.deepEqual(stripSpans(canonical.ir), stripSpans(legacy.ir));
});

// ---- both backends emit identically for canonical and legacy spellings --

const irOf = (src) => lowered(src).ir;

test('backend-6502 emits the same C for utinyint and u8', () => {
  const canonical = emitC(irOf('let x: utinyint = 10;\nexport function main(): void { x = x + 1; }'));
  const legacy = emitC(irOf('let x: u8 = 10;\nexport function main(): void { x = x + 1; }'));
  assert.equal(canonical, legacy);
  assert.match(canonical, /uint8_t x = 10;/);
});

test('backend-web emits the same AssemblyScript for utinyint and u8', () => {
  const canonical = emitAssemblyScript(irOf('let x: utinyint = 10;\nexport function main(): void { x = x + 1; }'));
  const legacy = emitAssemblyScript(irOf('let x: u8 = 10;\nexport function main(): void { x = x + 1; }'));
  assert.equal(canonical.source, legacy.source);
  assert.match(canonical.source, /export let x: u8 = 10;/);
});

test('@address + volatile<utinyint> emits the same hardware register as volatile<u8>', () => {
  const canonical = emitC(irOf('@address(0xD020)\nlet border: volatile<utinyint>;'));
  const legacy = emitC(irOf('@address(0xD020)\nlet border: volatile<u8>;'));
  assert.equal(canonical, legacy);
  assert.match(canonical, /#define border \(\*\(volatile uint8_t \*\)0xD020\)/);
});

test('int and uint are 32-bit types, not 16-bit', () => {
  const ir32 = lowered('let x: int = 0;\nlet y: uint = 0;').ir;
  assert.equal(ir32.globals[0].type, 'int');
  assert.equal(ir32.globals[1].type, 'uint');

  const cOut = emitC(irOf('let x: int = 0;\nexport function main(): void { x = x + 1; }'));
  assert.match(cOut, /int32_t x = 0;/);
});
