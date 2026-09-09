// The Commander X16 target package: a border through a VERA active-area
// inset and a background painted into every cell's attribute byte
// (src/screen.8bs), and a `text` namespace that speaks ASCII because
// start-up leaves the KERNAL in ISO mode (src/text.8bs), both on the VERA
// port helpers src/index.8bs exports. See those files for the why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, '..', '..', 'studio', 'src', 'main.8bs');
const NATIVE_BACKEND_PENDING = 'Bare Metal: waiting on the native backend';

test('a screen and text consumer links for cx16 and drives VERA by its port addresses', () => {
  const consumer = [
    'import { screen } from "@8bitscript/screen";',
    'import { text } from "@8bitscript/text";',
    'export function main(): void {',
    '    text.putChar(162, 84);',
    '    text.putColor(162, 1);',
    '    screen.setColors(6, 3);',
    '    text.printNumber(167, 2, 1);',
    '}',
  ].join('\n');
  const { ir, diagnostics } = link(consumer, ENTRY, { machine: 'cx16' });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(ir.nativeSources, []); // the X16 ships no native files

  const fn = (name) => ir.functions.find((f) => f.name === name);
  const main = fn('main');
  assert.deepEqual(main.body[0].args.map((a) => a.value), [162, 84]);
  const setVram = fn('setVramAddress');
  assert.deepEqual(setVram.body[0].address, { kind: 'const', value: 40736 });
  assert.equal(setVram.body[0].value.operator, '%');
  assert.deepEqual(setVram.body[2].address, { kind: 'const', value: 40738 });
  assert.equal(fn('text_putChar').body[1].kind, 'memoryWrite');
  assert.deepEqual(fn('text_putChar').body[1].address, { kind: 'const', value: 40739 });
  const map = fn('locateTextMap');
  assert.deepEqual(map.body[0].value.left.address, { kind: 'const', value: 40757 });
  assert.equal(map.body[0].value.operator, '/');
  assert.equal(map.body[1].value.operator, '%');
  assert.deepEqual(map.body[2].value.right, { kind: 'const', value: 512 });
  const locate = fn('locate');
  assert.equal(locate.body[1].name, 'high');
  assert.deepEqual(locate.body[1].init.right, { kind: 'const', value: 256 });
  assert.equal(locate.body[2].name, 'x');
  assert.deepEqual(locate.body[2].init.left.right, { kind: 'const', value: 28 });
  assert.equal(locate.body[3].name, 'row');
  assert.deepEqual(locate.body[3].init.left.right, { kind: 'const', value: 3 });
  assert.equal(locate.body[4].name, 'col');
  const addrSel = locate.body.filter((s) => s.kind === 'memoryWrite' && s.address.value === 40741);
  assert.deepEqual(addrSel.map((s) => s.value.value), [1, 0]);
  const walk = (node, visit) => {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const v of Object.values(node)) walk(v, visit);
  };
  let hardcodedMap = false;
  walk(ir, (n) => {
    if (n.kind === 'const' && (n.value === 0x1B000 || n.value === 45056)) hardcodedMap = true;
  });
  assert.equal(hardcodedMap, false, 'no hardcoded $1B000 anywhere');
  const putColor = fn('text_putColor').body[2];
  assert.deepEqual(putColor.address, { kind: 'const', value: 40739 });
  assert.equal(putColor.value.operator, '|');
  assert.deepEqual(putColor.value.left.left.address, { kind: 'const', value: 40740 });
  const inset = fn('insetPicture').body.filter((s) => s.kind === 'memoryWrite');
  assert.deepEqual(inset.slice(0, 6).map((s) => [s.address.value, s.value.value]), [
    [40741, 2], [40745, 4], [40746, 156], [40747, 8], [40748, 232], [40741, 0],
  ]);
  const setColors = fn('screen_setColors');
  assert.equal(setColors.body[0].name, 'insetPicture');
  assert.deepEqual(setColors.body[1].address, { kind: 'const', value: 40741 });
  assert.deepEqual(setColors.body[2].address, { kind: 'const', value: 40748 });
  const scroll = inset.filter((s) => s.address.value === 40761 || s.address.value === 40762);
  assert.deepEqual(scroll.map((s) => [s.address.value, s.value.value]), [[40761, 254], [40762, 1]]);
  const repaint = setColors.body.find((s) => s.kind === 'for');
  assert.deepEqual(repaint.test.right, { kind: 'const', value: 64 });
  const attr = repaint.body.find((s) => s.kind === 'for');
  assert.deepEqual(attr.body[0].address, { kind: 'const', value: 40739 });
  assert.equal(attr.body[0].value.operator, '+');
  assert.deepEqual(attr.body[0].value.left.right, { kind: 'const', value: 16 });
});

// TODO: restore once a multi-target screen-and-text probe exists.
test('a shared screen-and-text program links clean for cx16', { skip: NATIVE_BACKEND_PENDING }, () => {});
