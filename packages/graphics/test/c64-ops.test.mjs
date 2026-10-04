// The C64 twin's operations, at the level CI can check. The machine packages'
// own tests (packages/c64/test/graphics-ops.test.mjs, which reads the
// operations back from x64sc screenshots) are not part of the CI gate
// (scripts/ci-excluded-packages.mjs), so this file holds the two things that
// can run anywhere: the emulator probes still build for the C64, and the
// twin's rules are still what those screenshots measured. Each rule has a
// mutation beside it that must make it fail, so a rule that matches nothing
// cannot pass for the right reasons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(HERE, '..', '..', '..');
const TWIN = join(CHECKOUT, 'packages', 'graphics', 'src', 'index.c64.8bs');
const SPRITES = join(CHECKOUT, 'packages', 'sprites', 'src', 'index.c64.8bs');
const GEOMETRY = join(CHECKOUT, 'packages', 'c64', 'src', 'geometry.8bs');
const PROBES = join(CHECKOUT, 'packages', 'c64', 'test');

test('the C64 operation probes link, and each reaches the calls it exercises', () => {
  const cases = [
    ['graphics-ops-probe.8bs', ['graphics_place', 'graphics_hide', 'graphics_setFrame', 'graphics_animate', 'graphics_color', 'graphics_step']],
    ['graphics-line-probe.8bs', ['graphics_place', 'graphics_step']],
    ['graphics-raster-probe.8bs', ['graphics_place', 'graphics_step', 'multiplex_update']],
    ['graphics-wrap-probe.8bs', ['graphics_place', 'graphics_step']],
  ];
  for (const [file, calls] of cases) {
    const path = join(PROBES, file);
    const { ir, diagnostics } = link(readFileSync(path, 'utf8'), path, {
      machine: 'c64', facts: stockFacts('c64'), checkout: CHECKOUT,
    });
    assert.deepEqual(diagnostics, [], file);
    const names = ir.functions.map((f) => f.name);
    for (const call of calls) assert.ok(names.includes(call), `${file}: ${call} is linked`);
  }
});

const source = readFileSync(TWIN, 'utf8');

// [name, matches(source), [from, to]]: `to` is the same code with the rule
// broken, which `matches` must then reject.
const RULES = [
  ['place sends a sprite that starts past the playfield to the sprite layer\'s "not drawn" y, before the origin can wrap it',
    (s) => /let chipY: usmallint = y \+ sprites\.ORIGIN_Y;\s*if \(x >= PLAYFIELD_WIDTH \|\| y > LAST_Y\) \{\s*chipY = 255;\s*\}\s*sprites\.place\(slot, x \+ sprites\.ORIGIN_X, chipY\);/.test(s),
    ['x >= PLAYFIELD_WIDTH || y > LAST_Y', 'y > LAST_Y']],
  ['the vertical guard is the same for a 16-bit y near 65535 as for one just past the picture',
    (s) => /if \(x >= PLAYFIELD_WIDTH \|\| y > LAST_Y\)/.test(s),
    ['x >= PLAYFIELD_WIDTH || y > LAST_Y', 'x >= PLAYFIELD_WIDTH']],
  ['setFrame clamps a frame past the last one',
    (s) => /if \(n >= frameCount\[slot\]\) \{\s*n = frameCount\[slot\] - 1;\s*\}/.test(s),
    ['n = frameCount[slot] - 1;', 'n = n;']],
  ['animate(false) pauses and animate(true) resumes',
    (s) => /paused\[slot\] = 1;\s*if \(on\) \{\s*paused\[slot\] = 0;\s*\}/.test(s),
    ['if (on) {\n            paused[slot] = 0;', 'if (on) {\n            paused[slot] = 1;']],
  ['step skips a paused sprite and a single-frame one',
    (s) => /if \(frameCount\[slot\] < 2 \|\| paused\[slot\] != 0\) \{\s*continue;/.test(s),
    ['frameCount[slot] < 2 || paused[slot] != 0', 'frameCount[slot] < 2']],
  ['update is step then the sprite layer\'s whole frame',
    (s) => /graphics\.step\(\);\s*sprites\.update\(\);/.test(s),
    ['        graphics.step();\n        sprites.update();', '        sprites.update();']],
  ['color hands the colour straight to the sprite layer',
    (s) => /function color\(slot: utinyint, c: utinyint\): void \{\s*if \(slot >= SLOTS\) \{\s*return;\s*\}\s*ensure\(\);\s*sprites\.setColor\(slot, c\);/.test(s),
    ['sprites.setColor(slot, c);', 'sprites.setColor(slot, 1);']],
  ['hide passes the slot to the sprite layer, inside the slot-range check',
    (s) => /function hide\(slot: utinyint\): void \{\s*if \(slot >= SLOTS\) \{\s*return;\s*\}\s*ensure\(\);\s*sprites\.hide\(slot\);/.test(s),
    ['ensure();\n        sprites.hide(slot);\n    }\n\n    function setFrame', 'ensure();\n    }\n\n    function setFrame']],
];

for (const [name, matches, [from, to]] of RULES) {
  test(`C64 twin: ${name}`, () => {
    assert.ok(matches(source), 'the twin states the rule');
    assert.ok(source.includes(from), `the mutation's target is in the twin: ${from}`);
    assert.equal(matches(source.replace(from, to)), false, 'and the rule fails without it');
  });
}

test('C64 twin: the edge constants are the machine\'s, not guesses', () => {
  const number = (text, pattern) => {
    const m = pattern.exec(text);
    assert.ok(m, `${pattern} is in the file`);
    return Number(m[1]);
  };
  const width = number(source, /const PLAYFIELD_WIDTH: usmallint = (\d+);/);
  const lastY = number(source, /const LAST_Y: usmallint = (\d+);/);
  const originY = number(readFileSync(SPRITES, 'utf8'), /const ORIGIN_Y: usmallint = (\d+);/);
  const columns = number(readFileSync(GEOMETRY, 'utf8'), /COLUMNS: utinyint = (\d+);/);
  // 40 columns of 8 pixels; the chip's y byte tops out at 254 (255 is hidden).
  assert.equal(width, columns * 8);
  assert.equal(lastY + originY, 254);
});
