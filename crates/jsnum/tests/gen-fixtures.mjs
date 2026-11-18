// Regenerates fixtures.json, the Node-produced expectations the jsnum tests
// read. Run from the repo root: node crates/jsnum/tests/gen-fixtures.mjs
// fold rows are [op, left, right, type, result]; wrap rows are [value, type, result].
// Numbers are written as strings because JSON has no NaN, Infinity or -0.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveIntegerType } from '../../../packages/compiler/src/types/index.mjs';

const str = (n) => (Object.is(n, -0) ? '-0' : String(n));

const numbers = [
  0, -0, 1, -1, 0.5, -0.5, 1.5, -1.5, 2.5, 0.1, 0.2, 0.3, 255, 256, 257, -255, -256, -257,
  65535, 65536, 65537, 127, 128, -128, -129, 32767, 32768, -32768, -32769,
  2147483647, 2147483648, 2147483649, -2147483648, -2147483649,
  4294967295, 4294967296, 4294967297, -4294967295, -4294967296, -4294967297,
  16777215, 16777216, 9007199254740991, 9007199254740992, -9007199254740991,
  1e15, 1e20, 1e21, 1.5e21, 123456789012345680000, 1e22, 1e100, 1.7976931348623157e308,
  5e-324, 1e-7, 1.5e-7, 1e-6, 1.5e-6, 0.000001234, 123.456, 1e300, -1e21, -1e-7,
  4294967295.9, -4294967295.9, 2147483647.9, -2147483648.9, 1099511627776, 1e10, 3e9,
  NaN, Infinity, -Infinity,
];

const out = {
  numbers: numbers.map((n) => ({
    n: str(n),
    int32: n | 0,
    uint32: n >>> 0,
    uint8: new Uint8Array([n])[0],
    string: String(n),
  })),
};

const strings = [
  '', 'a', 'b', 'ab', 'abc', 'A', 'Z', 'a0', 'a1', 'a10', 'a2', '_', 'é', 'z',
  'ÿ', 'Ā', '～', '�', '\u{10000}', '\u{1f600}', '\u{10ffff}',
  'a\u{1f600}', 'a～', 'x\u{10000}y', 'x￿y', '\u0000', '\u0000a',
];
out.cmp = [];
for (const a of strings) {
  for (const b of strings) out.cmp.push({ a, b, ord: a < b ? -1 : a > b ? 1 : 0 });
}

const keySets = [
  [],
  ['b', 'a', '1', '0'],
  ['10', '9', '2', 'x', '01', '-1', '1.5', '4294967294', '4294967295', '4294967296'],
  ['name', '3', 'size', '1', '2'],
  ['00', '0', '', ' 1', '1 ', '+1', '1e3', '999999999999'],
];
out.keyOrder = keySets.map((keys) => {
  const obj = {};
  for (const k of keys) obj[k] = true;
  return { keys, order: Object.keys(obj) };
});

// The arithmetic arms of constValue (linker/optimize.mjs), word for word.
function wrapUnsigned(value, type) {
  const desc = resolveIntegerType(type);
  if (!desc || desc.signed) return null;
  const mod = desc.max + 1;
  return ((value % mod) + mod) % mod;
}
function fold(op, left, right, type) {
  switch (op) {
    case '+': return wrapUnsigned(left + right, type);
    case '-': return wrapUnsigned(left - right, type);
    case '*': return wrapUnsigned(left * right, type);
    case '/': return right === 0 ? null : wrapUnsigned(Math.floor(left / right), type);
    case '%': return right === 0 ? null : wrapUnsigned(left % right, type);
    case '&': return wrapUnsigned(left & right, type);
    case '|': return wrapUnsigned(left | right, type);
    case '^': return wrapUnsigned(left ^ right, type);
    case '<<': return wrapUnsigned(left * 2 ** right, type);
    case '>>': return wrapUnsigned(Math.floor(left / 2 ** right), type);
    default: return null;
  }
}
const ops = ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'];
const types = ['utinyint', 'u8', 'usmallint', 'umediumint', 'u32', 'tinyint', 'int', 'bool', 'nonsense'];
const operands = [0, 1, 3, 8, 16, 31, 32, 255, 256, 65535, 16777215, 4294967295, -1, -256, 1e10];
out.fold = [];
for (const type of types) {
  for (const op of ops) {
    for (const l of operands) {
      for (const r of operands) {
        const v = fold(op, l, r, type);
        out.fold.push([op, str(l), str(r), type, v === null ? null : str(v)]);
      }
    }
  }
}
out.wrap = [];
for (const type of types) {
  for (const v of numbers) {
    const w = wrapUnsigned(v, type);
    out.wrap.push([str(v), type, w === null ? null : str(w)]);
  }
}

// js_trim, JS_WS / is_js_whitespace, utf16_len, hex_upper, parse_int, math_round.
const trimStrings = [
  '', ' ', 'a', ' a ', '\t\n\v\f\r a \r\n', ' a ', '﻿a﻿', '\u0085a\u0085',
  ' x  ', '  x  　', '​x​', 'a b', '᠎x᠎',
  '\u{1f600} x ', '\u0000x\u0000',
];
out.trim = trimStrings.map((s) => [s, s.trim()]);
out.ws = [];
for (let c = 0; c < 0x10000; c++) {
  if (c >= 0xd800 && c <= 0xdfff) continue;
  if (/\s/.test(String.fromCharCode(c))) out.ws.push(c);
}
out.utf16 = trimStrings.concat(['é', '\u{10000}', 'a\u{1f600}b', '～']).map((s) => [s, s.length]);
out.hex = [];
for (const v of [0, 1, 5, 10, 15, 16, 255, 256, 4095, 65535, 65536, 2 ** 31, 2 ** 40, -1, -5, -255, -65536]) {
  for (const w of [0, 1, 2, 4, 8]) {
    out.hex.push([v, w, v.toString(16).toUpperCase().padStart(w, '0')]);
  }
}
out.parseInt = [];
for (const [d, r] of [
  ['0', 10], ['7', 10], ['0123', 10], ['65535', 10], ['9007199254740993', 10], ['18446744073709551615', 10],
  ['123456789012345678901234567890', 10], ['0', 16], ['ff', 16], ['FF', 16], ['dEaDbEeF', 16],
  ['ffffffffffffffff', 16], ['fffffffffffff800', 16], ['20000000000001', 16], ['1fffffffffffff', 16],
  ['0', 2], ['1', 2], ['101010', 2], ['11111111111111111111111111111111', 2],
  ['100000000000000000000000000000000000000000000000000001', 2],
]) {
  out.parseInt.push([d, r, str(Number.parseInt(d, r))]);
}
out.round = [
  0, -0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.49999999999999994, -0.49999999999999994, 0.2, -0.2,
  4503599627370495.5, 4503599627370497, -4503599627370497, 1e21, -1e21, 255.5, 59.94, NaN, Infinity, -Infinity,
].map((n) => [str(n), str(Math.round(n))]);

const target = fileURLToPath(new URL('./fixtures.json', import.meta.url));
writeFileSync(target, JSON.stringify(out) + '\n');
console.log(
  `numbers ${out.numbers.length}, cmp ${out.cmp.length}, keyOrder ${out.keyOrder.length}, fold ${out.fold.length}, wrap ${out.wrap.length}`,
);
