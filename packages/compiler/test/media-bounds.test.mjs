// The hit box of each sprite is worked out while the .8bg is elaborated: the union, over every
// frame, of the pixels with alpha >= 16 as [left, top, right, bottom] (right and bottom exclusive),
// and the generated binder ends with the call that hands it to the graphics driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '@8bitscript/graphics-tools';
import { analyzeMedia, Codes } from '../index.mjs';
import { elaborateMedia } from '../src/media/elaborate.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function picture(width, height, opaque) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) if (opaque(x, y)) rgba.set([255, 255, 255, 255], (y * width + x) * 4);
  }
  return encodePng(width, height, rgba);
}

const PICTURES = {
  solid: picture(16, 16, () => true),
  margin: picture(16, 16, (x, y) => x >= 3 && x <= 12 && y >= 3 && y <= 12),
  blank: picture(8, 8, () => false),
  two: picture(32, 16, (x, y) => (x < 16 ? x < 4 && y < 8 : x >= 28 && y >= 8)),
};

const ART = `sprite solid { source "./solid.png" size 16x16 transparent auto }
sprite margin { source "./margin.png" size 16x16 transparent auto }
sprite blank { source "./blank.png" size 8x8 transparent auto }
sprite two { source "./two.png" size 16x16 transparent auto }
sprite gone { source "./gone.png" size 16x16 transparent auto }
`;

function elaborate(dir) {
  const file = join(dir, 'art.8bg');
  const { gir, diagnostics: front } = analyzeMedia(ART, file, { sourceKind: '.8bg' });
  assert.deepEqual(front, []);
  const diagnostics = [];
  const { ir } = elaborateMedia({ file, media: { kind: '.8bg', gir } }, diagnostics, { machine: 'c64', facts: stockFacts('c64'), checkout: CHECKOUT });
  return { ir, diagnostics };
}

test('each sprite binder ends with the bounds call, holding the box of its opaque pixels over every frame', () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-bounds-'));
  try {
    for (const [name, png] of Object.entries(PICTURES)) writeFileSync(join(dir, `${name}.png`), png);
    const { ir, diagnostics } = elaborate(dir);
    const expected = {
      solid: [0, 0, 16, 16],
      margin: [3, 3, 13, 13],
      blank: [0, 0, 0, 0],
      two: [0, 0, 16, 16],
      gone: [0, 0, 0, 0],
    };
    Object.keys(expected).forEach((name, slot) => {
      const binder = ir.functions.find((f) => f.name === `__8bs_media_bind_${name}`);
      assert.ok(binder, name);
      const last = binder.body.at(-1);
      assert.equal(last.kind, 'namespaceCall', name);
      assert.equal(last.namespace, 'graphics', name);
      assert.equal(last.member, 'bounds', name);
      assert.deepEqual(last.args.map((a) => a.value), [slot, ...expected[name]], name);
      assert.ok(last.args.every((a) => a.kind === 'const' && a.type === 'utinyint'), name);
      assert.equal(binder.body.at(-2).member, 'meta', `${name}: bounds follows meta`);
    });
    const missing = diagnostics.filter((d) => d.code === Codes.GFX_MISSING_SOURCE);
    assert.equal(missing.length, 1, 'the missing source is still reported once');
    assert.equal(diagnostics.length, 1, 'and nothing else is');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
