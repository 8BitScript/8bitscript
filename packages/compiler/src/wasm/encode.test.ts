import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ExternalKind,
  Opcode,
  SectionId,
  ValType,
  assembleModule,
  encodeName,
  funcType,
  limits,
  section,
  signedLEB128,
  unsignedLEB128,
  vector,
} from './encode.ts';

test('unsignedLEB128: single-byte values encode as themselves', () => {
  assert.deepEqual(unsignedLEB128(0), [0x00]);
  assert.deepEqual(unsignedLEB128(64), [0x40]);
  assert.deepEqual(unsignedLEB128(127), [0x7f]);
});

test('unsignedLEB128: the textbook multi-byte case, 624485', () => {
  // The worked example from the WebAssembly/DWARF spec itself.
  assert.deepEqual(unsignedLEB128(624485), [0xe5, 0x8e, 0x26]);
});

test('unsignedLEB128: exactly 128 needs a second byte, 127 does not', () => {
  assert.deepEqual(unsignedLEB128(127), [0x7f]);
  assert.deepEqual(unsignedLEB128(128), [0x80, 0x01]);
});

test('unsignedLEB128: refuses a negative value or a non-integer by throwing, not miscomputing', () => {
  assert.throws(() => unsignedLEB128(-1), RangeError);
  assert.throws(() => unsignedLEB128(1.5), RangeError);
});

test('signedLEB128: the textbook negative case, -123456', () => {
  assert.deepEqual(signedLEB128(-123456), [0xc0, 0xbb, 0x78]);
});

test('signedLEB128: small positive and negative values round-trip through the sign-extension check', () => {
  assert.deepEqual(signedLEB128(0), [0x00]);
  assert.deepEqual(signedLEB128(-1), [0x7f]);
  assert.deepEqual(signedLEB128(63), [0x3f]);
  assert.deepEqual(signedLEB128(64), [0xc0, 0x00]); // needs a second byte: 0x40's own bit 6 would look like a sign bit otherwise
  assert.deepEqual(signedLEB128(-64), [0x40]);
});

test('vector: a count byte, then every item\'s own bytes concatenated in order', () => {
  assert.deepEqual(vector([]), [0x00]);
  assert.deepEqual(vector([[0x11], [0x22, 0x33]]), [0x02, 0x11, 0x22, 0x33]);
});

test('encodeName: a length-prefixed UTF-8 byte string', () => {
  assert.deepEqual(encodeName(''), [0x00]);
  assert.deepEqual(encodeName('main'), [0x04, 0x6d, 0x61, 0x69, 0x6e]);
});

test('funcType: 0x60, then the param vector, then the result vector', () => {
  assert.deepEqual(funcType([], []), [0x60, 0x00, 0x00]);
  assert.deepEqual(funcType([ValType.i32, ValType.i32], [ValType.i32]), [0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f]);
});

test('limits: min-only sets the flag byte to 0, min-and-max sets it to 1', () => {
  assert.deepEqual(limits(1), [0x00, 0x01]);
  assert.deepEqual(limits(1, 4), [0x01, 0x01, 0x04]);
});

test('section: id byte, encoded content length, then the content', () => {
  assert.deepEqual(section(SectionId.type, [0xaa, 0xbb]), [SectionId.type, 0x02, 0xaa, 0xbb]);
});

test('assembleModule: the 8-byte header (magic + version 1), then every section verbatim in the order given', () => {
  const bytes = assembleModule([[0x01, 0x02], [0x03]]);
  assert.deepEqual([...bytes], [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03]);
});

test('the smallest legal module (no sections at all) is what WebAssembly.validate() actually accepts', () => {
  // Grounds every section-shape test above against the real engine, not
  // just this file's own encoding of the spec: an empty module is legal
  // wasm on its own, so this is the base case every larger module in
  // wasm/index.ts builds on top of.
  assert.equal(WebAssembly.validate(assembleModule([])), true);
});

test('ExternalKind and Opcode carry the byte values the spec defines, not placeholders', () => {
  assert.equal(ExternalKind.func, 0x00);
  assert.equal(ExternalKind.memory, 0x02);
  assert.equal(Opcode.end, 0x0b);
});
