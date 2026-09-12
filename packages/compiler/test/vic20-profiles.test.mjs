// @8bitscript/vic20 across its RAM options: one surface (screen.8bs,
// text.8bs), one geometry file with an `expanded` twin beside it, and the
// build's hardware tags — from the package's own catalog — deciding where
// the screen is. The real package, through the real pnpm-linked
// node_modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIC20_SRC = join(HERE, '..', '..', 'vic20', 'src');
const CONSUMER = [
  'import { screen } from "@8bitscript/screen";',
  'import { text } from "@8bitscript/text";',
  'export function main(): void { screen.blank(); text.putColor(0, 1); }',
].join('\n');
const ENTRY = join(HERE, '..', '..', 'studio', 'src', 'main.8bs');

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
  const { ir, diagnostics } = link(CONSUMER, ENTRY, { machine: 'vic20', tags: tagsFor(ram) });
  assert.deepEqual(diagnostics, [], String(ram));
  const blank = ir.functions.find((f) => f.name === 'screen_blank');
  const loop = blank.body.find((s) => s.kind === 'for');
  const prepare = ir.functions.find((f) => f.name === 'prepare');
  const putColor = ir.functions.find((f) => f.name === 'text_putColor');
  return {
    ir,
    cells: loop.test.right.value,
    screen: loop.body[0].address.left.value,
    color: putColor.body[0].address.left.value,
    pointer: prepare.body[0].value.value,
  };
};

// The pointer's low nybble is the character ROM block: 2 is the mixed-case
// one at $8800, which is what text.8bs selects so a string draws as it was
// written (see that file's header). The high nybble is the screen base, and
// that is what differs between the two profiles.
const UNEXPANDED = { screen: 0x1E00, color: 0x9600, pointer: 0xF2 };
const EXPANDED = { screen: 0x1000, color: 0x9400, pointer: 0xC2 };

test('unexpanded and 3k draw at $1E00/$9600 with $9005 = $F2; 8k, 16k and 24k at $1000/$9400 with $C2', () => {
  for (const profile of [undefined, 'none', '3k']) {
    const geo = linked(profile);
    assert.equal(geo.screen, UNEXPANDED.screen, `${profile}: screen base`);
    assert.equal(geo.color, UNEXPANDED.color, `${profile}: color RAM base`);
    assert.equal(geo.pointer, UNEXPANDED.pointer, `${profile}: $9005 value`);
    assert.notEqual(geo.screen, EXPANDED.screen, `${profile}: no expanded screen base`);
  }
  for (const profile of ['8k', '16k', '24k']) {
    const geo = linked(profile);
    assert.equal(geo.screen, EXPANDED.screen, `${profile}: screen base`);
    assert.equal(geo.color, EXPANDED.color, `${profile}: color RAM base`);
    assert.equal(geo.pointer, EXPANDED.pointer, `${profile}: $9005 value`);
    assert.notEqual(geo.screen, UNEXPANDED.screen, `${profile}: no unexpanded screen base`);
    assert.notEqual(geo.color, UNEXPANDED.color, `${profile}: no unexpanded color RAM`);
  }
});

test('the screen is still 22 x 23 on every profile: only where it is changes', () => {
  for (const profile of ['none', '8k']) {
    assert.equal(linked(profile).cells, 506, profile);
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
