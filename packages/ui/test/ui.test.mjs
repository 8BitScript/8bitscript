// @8bitscript/ui is a component library, so its tests hold it to what that
// promises: a component is reached by name, it is built on the portable
// capability packages and nothing machine-specific, and it links for every
// target — because a component that works on eight of nine machines is not
// a component, it is a machine's code in the wrong package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];

test('every component is a subpath, and there is no bare entry', () => {
  const exports = pkg['8bitscript'].exports;
  assert.deepEqual(Object.keys(exports), ['./menubar']);
  for (const [key, value] of Object.entries(exports)) {
    assert.ok(existsSync(join(ROOT, value)), `${key} names ${value}, which does not exist`);
  }
  // Deliberate: a program imports the components it uses and links those
  // only. There is nothing sensible for `import ... from "@8bitscript/ui"`
  // to mean, so the package does not offer it.
  assert.equal(pkg['8bitscript'].entry, undefined);
});

test('a component is built on the portable capabilities, never on a machine', () => {
  // A component that reached for @8bitscript/c64 would compile — and would
  // be a C64 program wearing a portable name.
  const machines = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];
  for (const file of readdirSync(SRC)) {
    const source = readFileSync(join(SRC, file), 'utf8');
    // Real import statements only: the file's own doc comment shows a
    // consumer's `import ... from "@8bitscript/ui/menubar"`.
    for (const [, specifier] of source.matchAll(/^import\s[^;]*\sfrom\s+"([^"]+)"/gm)) {
      if (!specifier.startsWith('@8bitscript/')) continue;
      const name = specifier.split('/')[1];
      assert.ok(!machines.includes(name), `${file} imports ${specifier}`);
      assert.ok(pkg.dependencies[`@8bitscript/${name}`], `${file} imports ${specifier}, which is not a dependency`);
    }
  }
});

// One program using every call the menubar offers: if it links for a
// target, the whole component compiles there.
const PROBE = join(HERE, 'menubar-probe.8bs');

for (const target of TARGETS) {
  test(`the menu bar links clean for ${target}`, () => {
    const source = readFileSync(PROBE, 'utf8');
    const { ir, diagnostics } = link(source, PROBE, { machine: target, facts: stockFacts(target) });
    assert.deepEqual(diagnostics, []);
    assert.equal(ir.entry, 'main');
  });
}

test('the menu bar offers the calls a program is written against', () => {
  const source = readFileSync(PROBE, 'utf8');
  const { ir } = link(source, PROBE, { machine: 'c64', facts: stockFacts('c64') });
  const names = new Set(ir.functions.map((f) => f.name));
  for (const call of [
    'menubar_setColors', 'menubar_setPadding', 'menubar_setMarker',
    'menubar_setIcon',
    'menubar_select', 'menubar_selected', 'menubar_deselect',
    'menubar_next', 'menubar_previous',
    'menubar_point', 'menubar_pointed',
    'menubar_begin', 'menubar_icon', 'menubar_item', 'menubar_end',
    'menubar_count', 'menubar_clipped',
  ]) {
    assert.ok(names.has(call), `${call} is missing from the linked program`);
  }
  // The machine's text package is linked once, not once per importer: the
  // probe imports @8bitscript/text and so does the component.
  assert.equal(ir.functions.filter((f) => f.name === 'text_print').length, 1);
});

test('the default marker is on the portable character set every target can draw', () => {
  // The checker enforces this for the labels a program passes in; the
  // component's own default marker is a literal here, so it is checked here.
  const source = readFileSync(join(SRC, 'menubar.8bs'), 'utf8');
  const marker = /let marker: string<1> = "(.*)";/.exec(source);
  assert.ok(marker, 'the default marker is a one-character string');
  assert.ok(marker[1].length <= 1, 'the marker takes one padding cell, so it is at most one character');
  for (const ch of marker[1]) {
    assert.ok(' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ!,-.:?'.includes(ch),
      `the default marker '${ch}' is not on the portable character set`);
  }
});

test('drawing goes through print, not putChar, everywhere but the one blanking loop', () => {
  // This is the difference between a 743-byte item() and a 320-byte one on
  // a C64 (AGENTS.md#what-it-costs). putChar redoes a machine's per-run
  // setup for every cell; print does it once per string. If a future
  // component reaches for putChar in a drawing path, this is the reminder.
  const source = readFileSync(join(SRC, 'menubar.8bs'), 'utf8');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const putChar = [...code.matchAll(/text\.putChar\(/g)];
  assert.equal(putChar.length, 1, 'only the blanking loop may put a character one cell at a time');
  assert.match(code, /function blank\(/, 'and that one call belongs to blank()');
  assert.match(code, /text\.setReverse\(on\)/, 'the selected item is inverted, not recolored');
  assert.match(code, /text\.setReverse\(false\)/, 'reverse is turned off after each item');
});

test('the highlight is invert on every machine, and colorPerCell is still the fact it was', () => {
  // Invert does not need per-cell color, so the bar no longer branches
  // on `video.colorPerCell`. The fact is still the split the PET, Atari
  // and NES make against the other six — the three whose `text.putColor`
  // is a deliberately empty function — and a later component that *does*
  // need a color per cell should still ask it.
  const noCellColor = ['pet', 'atari8', 'nes'];
  for (const target of TARGETS) {
    const colorPerCell = stockFacts(target)['video.colorPerCell'];
    assert.equal(colorPerCell, !noCellColor.includes(target),
      `${target} disagrees with the set of machines that can color one cell`);
  }
});

test('a bar starts deselected, and NONE is not an index any bar can produce', () => {
  // A menu bar before anyone has touched it has nothing highlighted, and
  // the sentinel that says so has to be a value no real item index can
  // reach — `index` is a utinyint, so 255 is the one number a bar of 255
  // items could never select.
  const source = readFileSync(join(SRC, 'menubar.8bs'), 'utf8');
  assert.match(source, /const NO_SELECTION: utinyint = 255;/);
  assert.match(source, /let highlighted: utinyint = NO_SELECTION;/,
    'a bar opens with nothing highlighted');
  assert.match(source, /let pointedIndex: utinyint = NO_SELECTION;/,
    'and with nothing under the pointer');
});

test('the pointer hit test never forms a sum that the two backends disagree about', () => {
  // `pointerAt < start + n` would add a 16-bit cell to a byte length, and
  // the 6502 build promotes while the web build wraps (the measurement is
  // in menubar.8bs and packages/ui/AGENTS.md). Two comparisons instead.
  const source = readFileSync(join(SRC, 'menubar.8bs'), 'utf8');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.match(code, /if \(pointerAt >= start\)/);
  assert.match(code, /if \(pointerAt - start < n\)/);
  assert.doesNotMatch(code, /pointerAt < start \+/,
    'the hit test must not add a length to a cell');
});
