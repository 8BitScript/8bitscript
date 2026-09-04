// Built-in hover and completion — see packages/compiler/src/intellisense.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getHoverInfo, getCompletions } from '../index.mjs';

const at = (text, needle) => text.indexOf(needle) + Math.floor(needle.length / 2);

// ---- hover ----------------------------------------------------------------

test('hover on a canonical integer type explains size, range, and alias', () => {
  const text = 'let x: utinyint = 3;';
  const info = getHoverInfo(text, at(text, 'utinyint'));
  assert.ok(info);
  assert.match(info.markdown, /Unsigned 1-byte integer/);
  assert.match(info.markdown, /Size: 1 byte \/ 8 bits/);
  assert.match(info.markdown, /0 through 255/);
  assert.match(info.markdown, /Low-level alias: u8/);
});

test('hover on a signed 3-byte type formats large numbers with separators', () => {
  const text = 'let x: mediumint = 3;';
  const info = getHoverInfo(text, at(text, 'mediumint'));
  assert.match(info.markdown, /Signed 3-byte integer/);
  assert.match(info.markdown, /Size: 3 bytes \/ 24 bits/);
  assert.match(info.markdown, /-8,388,608 through 8,388,607/);
  assert.match(info.markdown, /Low-level alias: i24/);
});

test('hover on int/uint shows the 4-byte type they now name', () => {
  let text = 'let x: int = 3;';
  let info = getHoverInfo(text, at(text, 'int'));
  assert.match(info.markdown, /Signed 4-byte integer/);
  assert.match(info.markdown, /-2,147,483,648 through 2,147,483,647/);
  assert.match(info.markdown, /Low-level alias: i32/);

  text = 'let x: uint = 3;';
  info = getHoverInfo(text, at(text, 'uint'));
  assert.match(info.markdown, /Unsigned 4-byte integer/);
  assert.match(info.markdown, /0 through 4,294,967,295/);
  assert.match(info.markdown, /Low-level alias: u32/);
});

test('hover on a legacy alias points back to the canonical name', () => {
  const text = 'let x: u8 = 3;';
  const info = getHoverInfo(text, at(text, 'u8'));
  assert.match(info.markdown, /Low-level alias for utinyint/);
  assert.match(info.markdown, /Unsigned 1-byte integer/);
  assert.match(info.markdown, /0 through 255/);
});

test('every canonical and legacy-alias spelling has hover', () => {
  const names = [
    'tinyint', 'utinyint', 'smallint', 'usmallint',
    'mediumint', 'umediumint', 'int', 'uint',
    'i8', 'u8', 'i16', 'u16', 'i24', 'u24', 'i32', 'u32',
  ];
  for (const name of names) {
    const text = `let x: ${name} = 0;`;
    const info = getHoverInfo(text, at(text, name));
    assert.ok(info, `expected hover for ${name}`);
    assert.match(info.markdown, new RegExp(name));
  }
});

test('hover explains volatile in 8BitScript terms, not C terms', () => {
  const text = '@address(0x900F)\nlet vicColor: volatile<u8>;';
  const info = getHoverInfo(text, at(text, 'volatile'));
  assert.match(info.markdown, /may change outside normal program execution/);
  assert.match(info.markdown, /memory-mapped hardware registers/);
  assert.doesNotMatch(info.markdown, /\bC\b/);
});

test('hover explains ptr and array', () => {
  let text = 'let cursor: ptr<u8>;';
  assert.match(getHoverInfo(text, at(text, 'ptr')).markdown, /pointer to a memory location/i);

  text = 'let buffer: array<u8, 16>;';
  assert.match(getHoverInfo(text, at(text, 'array')).markdown, /fixed-size array of N values/i);
});

test('hover explains asm6502', () => {
  const text = 'asm6502 {\n    lda #$06\n}\n';
  const info = getHoverInfo(text, at(text, 'asm6502'));
  assert.match(info.markdown, /raw 6502 assembly/);
});

test('hover explains @address', () => {
  const text = '@address(0x900F)\nlet vicColor: volatile<u8>;';
  const info = getHoverInfo(text, text.indexOf('@address') + 3);
  assert.match(info.markdown, /Binds a declaration to a specific memory address/);
});

test('hover explains memory.write and memory.read', () => {
  let text = 'export function f(): void { memory.write(36879, 27); }';
  let info = getHoverInfo(text, at(text, 'write'));
  assert.match(info.markdown, /Writes one byte directly/);
  assert.match(info.markdown, /POKE/);

  text = 'export function f(): void { let x: utinyint = memory.read(36879); }';
  info = getHoverInfo(text, at(text, 'read'));
  assert.match(info.markdown, /Reads one byte directly/);
  assert.match(info.markdown, /PEEK/);
});

test('hover does not fire on read/write unless qualified by memory.', () => {
  const text = 'export function f(): void { let write: utinyint = 0; }';
  assert.equal(getHoverInfo(text, at(text, 'write')), null);
});

test('hover explains seconds(...)', () => {
  const text = 'let x: utinyint = seconds(0.5);';
  const info = getHoverInfo(text, at(text, 'seconds'));
  assert.ok(info);
  assert.match(info.markdown, /Compile-time duration/);
  assert.match(info.markdown, /seconds\(0\.5\)/);
  assert.match(info.markdown, /frameRate/);
  assert.match(info.markdown, /8bs\.config\.ts/);
  assert.match(info.markdown, /Reserved/);
});

test('hover on seconds does not require a valid call — helps a reader mid-edit too', () => {
  const text = 'let x: utinyint = seconds();';
  const info = getHoverInfo(text, at(text, 'seconds'));
  assert.ok(info);
  assert.match(info.markdown, /Compile-time duration/);
});

test('hover on an unrelated identifier returns nothing: there is no binder yet', () => {
  const text = 'let myCounter: u8 = 0;';
  assert.equal(getHoverInfo(text, at(text, 'myCounter')), null);
});

test('hover on whitespace returns nothing', () => {
  // The blank line between the two statements touches no token at all.
  const text = 'let x: u8 = 0;\n\nlet y: u8 = 0;';
  const blankLineOffset = text.indexOf('\n\n') + 1;
  assert.equal(getHoverInfo(text, blankLineOffset), null);
});

// ---- completion -------------------------------------------------------

test('completion after a type colon offers canonical names in MySQL order, ahead of aliases', () => {
  const text = 'let x: ';
  const items = getCompletions(text, text.length);
  const labels = items.map((i) => i.label);

  const canonicalOrder = [
    'tinyint', 'utinyint', 'smallint', 'usmallint',
    'mediumint', 'umediumint', 'int', 'uint',
  ];
  for (const name of canonicalOrder) assert.ok(labels.includes(name), `missing ${name}`);
  assert.deepEqual(
    labels.filter((l) => canonicalOrder.includes(l)),
    canonicalOrder,
    'canonical types must be offered in tinyint/utinyint/.../int/uint order',
  );

  for (const name of ['array', 'ptr', 'volatile']) {
    assert.ok(labels.includes(name), `missing ${name}`);
  }

  const utinyintRank = items.find((i) => i.label === 'utinyint').sortRank;
  const u8Rank = items.find((i) => i.label === 'u8').sortRank;
  assert.ok(utinyintRank < u8Rank, 'canonical names must rank ahead of legacy aliases');
});

test('completion inside a type constructor argument also offers types', () => {
  const text = 'let p: ptr<';
  const items = getCompletions(text, text.length);
  assert.ok(items.some((i) => i.label === 'utinyint'));
});

test('completion is empty outside a type position', () => {
  const text = 'let x = ';
  assert.deepEqual(getCompletions(text, text.length), []);

  const compare = 'if (x < ';
  assert.deepEqual(getCompletions(compare, compare.length), []);
});
