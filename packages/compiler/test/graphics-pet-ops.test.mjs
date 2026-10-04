// The PET's graphics operations, held where CI runs them. The machine
// packages' own tests are not part of the CI gate
// (scripts/ci-excluded-packages.mjs), and the screenshots that show each
// call doing its job under xpet — hide, place again, setFrame and its
// clamp, animate off and on, a hidden object's frame, edges, what an object
// covered coming back — are packages/pet/test/graphics-ops.test.mjs. This
// file is the half that needs no emulator:
//
//   1. a program that calls every operation, on the PET, links with no
//      diagnostics on each model tag (2001, 3032, 4032, 8032), and the
//      calls are in the linked program;
//   2. the twin's source still says what each call has to do — the clamp,
//      the pause, the hide, the guard on an object with no shapes, the
//      no-op colour — the lines the screenshots test measures. Each of
//      these fails when the line they name is removed (checked by deleting
//      each in turn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(HERE, '..', '..', '..');
const TWIN = readFileSync(join(CHECKOUT, 'packages', 'graphics', 'src', 'index.pet.8bs'), 'utf8');

/** The body of `function name(...)` in the twin, up to its closing brace at four spaces. */
function body(name) {
  const start = TWIN.indexOf(`    function ${name}(`);
  assert.ok(start !== -1, `index.pet.8bs defines ${name}()`);
  const end = TWIN.indexOf('\n    }\n', start);
  return TWIN.slice(start, end);
}

const PROGRAM = `import { graphics } from "@8bitscript/graphics";
export function main(): void {
    graphics.place(0, 16, 16);
    graphics.place(1, 120, 136);
    graphics.hide(0);
    graphics.place(0, 16, 48);
    graphics.animate(1, false);
    graphics.setFrame(1, 2);
    graphics.setFrame(1, 9);
    graphics.animate(1, true);
    graphics.hide(1);
    graphics.color(1, 3);
    graphics.update();
    return;
}
`;

test('a program calling every graphics operation links on the 2001, 3032, 4032 and 8032 with no diagnostics', () => {
  for (const model of ['2001', '3032', '4032', '8032']) {
    const { ir, diagnostics } = link(PROGRAM, join(HERE, 'graphics-pet-ops-consumer.8bs'), {
      machine: 'pet', facts: stockFacts('pet'), tags: [model], checkout: CHECKOUT,
    });
    assert.deepEqual(diagnostics, [], model);
    const main = ir.functions.find((f) => f.name === 'main');
    const called = main.body.filter((s) => s.kind === 'call').map((s) => s.name);
    for (const call of ['place', 'hide', 'setFrame', 'animate', 'color', 'update']) {
      assert.ok(called.includes(`graphics_${call}`), `${model}: graphics.${call} is in the linked program`);
    }
  }
});

test('setFrame clamps past the last frame to the last frame, and does nothing for an object with no shapes', () => {
  const text = body('setFrame');
  assert.match(text, /if \(frameCount\[slot\] == 0\) \{\s*return;\s*\}/, 'an object with no shapes is not touched');
  assert.match(text, /if \(n >= frameCount\[slot\]\) \{\s*n = frameCount\[slot\] - 1;\s*\}/, 'a frame past the end is the last frame');
  assert.match(text, /tick\[slot\] = 0;/, 'a set frame restarts the interval');
  assert.match(text, /sprites\.setShape\(slot, base\[slot\] \+ n\);/, 'and is shown through the sprite layer');
});

test('animate(false) pauses automatic stepping, animate(true) resumes it, and update() skips a paused object', () => {
  const animate = body('animate');
  assert.match(animate, /paused\[slot\] = 1;\s*if \(on\) \{\s*paused\[slot\] = 0;\s*\}/);
  assert.match(body('update'), /frameCount\[slot\] < 2 \|\| paused\[slot\] != 0/);
});

test('hide hands the object to the sprite layer, which restores what it covered, and colour is an honest no-op', () => {
  assert.match(body('hide'), /sprites\.hide\(slot\);/);
  assert.match(TWIN, /const RECOLORS: bool = false;/);
  assert.match(body('color'), /function color\(slot: utinyint, c: utinyint\): void \{\s*$/, 'color takes the contract signature');
  assert.doesNotMatch(body('color').split('\n').slice(1).join('\n'), /\S/, 'and does nothing');
});
