// Intellisense on the new (Rust-shaped) syntax: a `use` specifier, a `::`
// fact key, and the `::` form in completion detail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { getHoverInfo, getCompletions } from '../index.mjs';

const at = (text, needle, into = 1) => text.lastIndexOf(needle) + into;

const withFiles = (files, fn) => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-intellisense-flip-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const BAR = 'pub let mut opened: utinyint = 0; // how many bars have been opened\n';
const REGISTERS = [
  'pub mod Registers {',
  '    fn blank(border: u8 = 0, background: u8 = 0) {',
  '        const local: u16 = 1;',
  '    }',
  '}',
].join('\n');

test('hover on the last segment of a `use` path reads the symbol it imports', () => {
  withFiles({ 'bar.8bs': BAR }, (dir) => {
    const text = 'use self::bar::opened;\nlet x: utinyint = opened;\n';
    const info = getHoverInfo(text, at(text, 'opened;', 3), { path: join(dir, 'main.8bs') });
    assert.ok(info, 'the specifier hovers');
    assert.match(info.markdown, /\*\*opened\*\* — variable/);
    assert.match(info.markdown, /how many bars have been opened/);
  });
});

test('hover on a `::` fact key finds the whole key from either word', () => {
  const text = 'const n: uint = #fact(video::columns);\n';
  for (const word of ['video', 'columns']) {
    const info = getHoverInfo(text, at(text, word, 1));
    assert.ok(info, `${word} hovers`);
    assert.match(info.markdown, /^\*\*video\.columns\*\*/);
    assert.equal(text.slice(info.start, info.start + info.length), 'video::columns');
  }
  const mouse = 'const m: bool = #fact(input::mouse);\n';
  assert.match(getHoverInfo(mouse, at(mouse, 'mouse'))?.markdown ?? '', /\*\*input\.mouse\*\*/);
  const other = 'const n: uint = #fact(video::nope);\n';
  assert.equal(getHoverInfo(other, at(other, 'nope')), null);
});

test('member completion detail uses the :: form hover uses', () => {
  withFiles({ 'registers.8bs': REGISTERS }, (dir) => {
    const text = 'use self::registers::Registers;\nRegisters::bl';
    const blank = getCompletions(text, text.length, { path: join(dir, 'main.8bs') }).find((c) => c.label === 'blank');
    assert.ok(blank);
    assert.match(blank.detail, /^Registers::blank\(/);
  });
});
