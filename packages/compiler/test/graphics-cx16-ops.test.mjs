// The X16 graphics twin's calls, held at the level CI can see. What they draw
// is proved under x16emu by packages/cx16/test/graphics-ops.test.mjs, which CI
// does not run (machine packages are excluded: scripts/ci-excluded-packages.mjs),
// so this file pins the shape each call must have and the numbers the twin
// shares with the hardware and with its media lowering. Each assertion was
// checked by breaking the twin it covers and watching it fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(HERE, '..', '..', '..');
const TWIN = readFileSync(join(CHECKOUT, 'packages', 'graphics', 'src', 'index.cx16.8bs'), 'utf8');

const PROBE = `import { graphics } from "@8bitscript/graphics";
export function main(): void {
    graphics.place(0, 0, 0);
    graphics.hide(0);
    graphics.setFrame(0, 1);
    graphics.animate(0, false);
    graphics.color(0, 1);
    graphics.update();
    return;
}
`;

function linked() {
  const { ir, diagnostics } = link(PROBE, join(HERE, 'graphics-cx16-ops-consumer.8bs'), { machine: 'cx16', facts: stockFacts('cx16'), checkout: CHECKOUT });
  assert.deepEqual(diagnostics, []);
  return ir;
}

// How many nodes of each kind a function's body holds, and the constants it
// compares or computes with.
function census(fn) {
  const kinds = {};
  const consts = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.kind) kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
    if (node.kind === 'const' && typeof node.value === 'number') consts.push(node.value);
    Object.values(node).forEach(walk);
  };
  walk(fn.body);
  return { kinds, consts };
}

const fn = (ir, name) => {
  const found = ir.functions.find((f) => f.name === name);
  assert.ok(found, `${name} is linked`);
  return census(found);
};

// A constant in the twin's source: `const NAME: type = value;` (hex or decimal).
function twinConst(name) {
  const match = new RegExp(`const ${name}: \\w+ = (0x[0-9A-Fa-f]+|\\d+);`).exec(TWIN);
  assert.ok(match, `the twin declares ${name}`);
  return Number(match[1]);
}

test('color() is a real call: a loop over the palette block, reads of the default palette, and the restore loop', () => {
  const color = fn(linked(), 'graphics_color');
  assert.equal(color.kinds.for, 2, 'a tint loop and a restore loop');
  assert.ok(color.kinds.memoryRead >= 3, 'it reads the default palette entry and the saved copy');
  assert.ok(color.kinds.memoryWrite >= 2, 'it writes the object\'s own palette block');
  assert.ok(color.consts.includes(16), 'a value from 16 up is the picture\'s own colors');
});

test('hide(), setFrame() and animate() each write the table or the attribute they own, and setFrame() clamps', () => {
  const ir = linked();
  const hide = fn(ir, 'graphics_hide');
  assert.ok(hide.kinds.call >= 2 && hide.kinds.storeIndex >= 1, 'hide() clears the shown flag and writes the z-depth');
  const setFrame = fn(ir, 'graphics_setFrame');
  assert.equal(setFrame.kinds.if, 4, 'setFrame() checks the slot, the frame count, the clamp, and whether it is shown');
  assert.ok(setFrame.kinds.storeIndex >= 2, 'and stores the frame and resets the tick');
  const animate = fn(ir, 'graphics_animate');
  assert.ok(animate.kinds.storeIndex >= 2, 'animate() sets the paused flag both ways');
});

test('a position off the screen switches the sprite off instead of wrapping: showSprite compares against 640 and 480', () => {
  const show = fn(linked(), 'showSprite');
  assert.ok(show.consts.includes(640) && show.consts.includes(480), 'x is compared with 640 and y with 480');
  assert.ok(show.kinds.if >= 1, 'and the comparison picks the z-depth');
  assert.equal(twinConst('SCREEN_X'), 640);
  assert.equal(twinConst('SCREEN_Y'), 480);
});

test('the palette copy sits in VRAM nothing else uses: past the eight sprite windows, short of the KERNAL sprites', () => {
  const windows = twinConst('DATA_LOW') + twinConst('SLOTS') * twinConst('WINDOW');
  const backup = twinConst('BACKUP_LOW');
  const bytes = twinConst('SLOTS') * twinConst('PALETTE_BYTES');
  assert.equal(backup, windows, 'the copy starts where the last window ends');
  assert.ok(backup + bytes <= 0x13000, 'and ends before the KERNAL\'s sprite data at $13000');
  assert.equal(twinConst('OWN_COLORS'), 16, 'colors 0..15 are the machine\'s; 16 up is the picture\'s own');
});

test('bind() keeps the copy color() restores from, for every palette byte', () => {
  const bind = fn(linked(), 'graphics_bind');
  assert.ok(bind.kinds.call >= 3, 'two writes for a palette byte (the block and the copy) and one for a pixel byte');
  assert.match(TWIN, /vramWrite\(0, BACKUP_LOW \+ wide \* 32 \+ index, value\);/);
});
