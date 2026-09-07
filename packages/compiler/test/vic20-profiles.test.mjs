// @8bitscript/vic20 across its RAM options: one surface (screen.8bs,
// text.8bs), one geometry file with an `expanded` twin beside it, and the
// build's hardware tags — from the package's own catalog — deciding where
// the screen is. The real package, through the real pnpm-linked
// node_modules, the way the borders example resolves it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';
import { emitC } from '../../backend-6502/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BORDERS_MAIN = join(HERE, '..', '..', '..', 'examples', 'borders', 'src', 'main.8bs');
const VIC20_SRC = join(HERE, '..', '..', 'vic20', 'src');

// The tags a `ram` value carries, read from the catalog the way the CLI
// reads it (packages/cli/src/hardware.mjs): the value's `tag` if it names
// one, else its own name, and none for the option's default.
const CATALOG = JSON.parse(readFileSync(join(VIC20_SRC, '..', 'package.json'), 'utf8'))['8bitscript'].hardware;
const tagsFor = (ram) => {
  if (ram === undefined) return [];
  const option = CATALOG.options.ram;
  const entry = option.values[ram];
  assert.ok(entry, `${ram} is a ram value`);
  if (Object.hasOwn(entry, 'tag')) return entry.tag === null ? [] : [entry.tag];
  return ram === option.default ? [] : [ram];
};

const linked = (ram) => {
  const src = readFileSync(BORDERS_MAIN, 'utf8');
  const { ir, diagnostics } = link(src, BORDERS_MAIN, { machine: 'vic20', tags: tagsFor(ram) });
  assert.deepEqual(diagnostics, [], String(ram));
  return emitC(ir, { machine: 'vic20' });
};

// The C the backend emits names the addresses in decimal: $1E00 is 7680,
// $9600 is 38400, $1000 is 4096, $9400 is 37888; the $9005 values $F0 and
// $C0 are 240 and 192.
const UNEXPANDED = { screen: 7680, color: 38400, pointer: 240 };
const EXPANDED = { screen: 4096, color: 37888, pointer: 192 };

const expectGeometry = (c, where, label) => {
  assert.match(c, new RegExp(`\\(${where.screen} \\+ `), `${label}: screen base`);
  assert.match(c, new RegExp(`\\(${where.color} \\+ `), `${label}: colour RAM base`);
  assert.match(c, new RegExp(` = ${where.pointer};`), `${label}: $9005 value`);
};

test('unexpanded and 3k draw at $1E00/$9600 with $9005 = $F0; 8k, 16k and 24k at $1000/$9400 with $C0', () => {
  for (const profile of [undefined, 'none', '3k']) {
    const c = linked(profile);
    expectGeometry(c, UNEXPANDED, String(profile));
    assert.doesNotMatch(c, /\(4096 \+ /, `${profile}: no expanded screen base`);
  }
  for (const profile of ['8k', '16k', '24k']) {
    const c = linked(profile);
    expectGeometry(c, EXPANDED, profile);
    assert.doesNotMatch(c, /\(7680 \+ /, `${profile}: no unexpanded screen base`);
    assert.doesNotMatch(c, /\(38400 \+ /, `${profile}: no unexpanded colour RAM`);
  }
});

test('the screen is still 22 x 23 on every profile: only where it is changes', () => {
  for (const profile of ['none', '8k']) {
    assert.match(linked(profile), /cell < 506/, profile);
  }
});

test('the 8k, 16k and 24k values share one `expanded` tag, and the one expanded geometry file differs from the base only where the screen is', () => {
  for (const ram of ['8k', '16k', '24k']) assert.deepEqual(tagsFor(ram), ['expanded'], ram);
  assert.deepEqual(tagsFor('3k'), ['3k']);
  assert.deepEqual(tagsFor('none'), []);
  const twins = readdirSync(VIC20_SRC).filter((f) => f.startsWith('geometry.'));
  assert.deepEqual(twins.sort(), ['geometry.8bs', 'geometry.vic20.expanded.8bs']);

  const namespaceOf = (file) => {
    const text = readFileSync(join(VIC20_SRC, file), 'utf8');
    const start = text.indexOf('export namespace Video');
    assert.ok(start >= 0, `${file}: has a Video namespace`);
    return text.slice(start).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  };
  const values = (ns) => Object.fromEntries([...ns.matchAll(/const (\w+): \w+ = (0x[0-9A-Fa-f]+|\d+);/g)].map(([, name, v]) => [name, Number(v)]));
  const b = values(namespaceOf('geometry.8bs'));
  const e = values(namespaceOf('geometry.vic20.expanded.8bs'));
  assert.deepEqual(Object.keys(b), Object.keys(e));
  assert.deepEqual([b.SCREEN, b.COLOR, b.MEMORY_POINTER_UPPERCASE], [0x1E00, 0x9600, 0xF0]);
  assert.deepEqual([e.SCREEN, e.COLOR, e.MEMORY_POINTER_UPPERCASE], [0x1000, 0x9400, 0xC0]);
  for (const name of ['COLUMNS', 'ROWS', 'CELL_COUNT']) assert.equal(e[name], b[name], name);
  assert.equal(b.CELL_COUNT, b.COLUMNS * b.ROWS);
  // $9005 bits 4-6 are the screen's address bits 10-12 (bit 7 is the inverted A15, RAM below $2000 either way): the constant and the address agree.
  for (const g of [b, e]) assert.equal((g.MEMORY_POINTER_UPPERCASE & 0x70) << 6, g.SCREEN & 0x1C00);
});
