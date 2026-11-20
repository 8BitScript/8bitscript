// The web's pixel sprites are sized by the build: the geometry constants the
// twin reads, the two twins' shared body, the option values, and a build with
// a small sprite table drawing the same pixels as one with the largest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { captureScreenshot } from '../src/screenshot.mjs';
import { encodePNG } from '../src/png.mjs';
import { loadCatalog, resolveHardware } from '../src/hardware.mjs';
import { layoutFromHardware, layoutForRealMachine } from '../src/web-layout.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const WEB_SRC = join(REPO, 'packages', 'web', 'src');
const GRAPHICS_SRC = join(REPO, 'packages', 'graphics', 'src');
const SHARED = '// ---- shared body ----';

const hardwareFor = (machine, overrides = {}) => {
  const resolved = resolveHardware(loadCatalog('web'), { defaults: machine ? { machine } : {}, overrides });
  assert.ok(resolved.hardware, resolved.error);
  return resolved.hardware;
};

const geometryFiles = {
  hifi: 'geometry.8bs',
  'hifi-hires': 'geometry.web.hifi-hires.8bs',
  'pet-2001': 'geometry.web.pet-2001.8bs',
  c64: 'geometry.web.c64.8bs',
  vic20: 'geometry.web.vic20.8bs',
};

const tableConst = (text) => Number(/const SPRITE_TABLE: usmallint = (\d+);/.exec(text)?.[1]);

for (const [machine, file] of Object.entries(geometryFiles)) {
  test(`${machine}: the geometry SPRITE_TABLE is where the agreement puts the sprite table`, () => {
    const layout = layoutFromHardware(hardwareFor(machine));
    assert.equal(tableConst(readFileSync(join(WEB_SRC, file), 'utf8')), layout.spriteTable);
  });
}

test('cx16 --web: the twin\'s SPRITE_TABLE literal is where its agreement puts the sprite table', () => {
  const catalog = loadCatalog('cx16');
  const { hardware } = resolveHardware(catalog, {});
  const layout = layoutForRealMachine('cx16', hardware);
  assert.equal(tableConst(readFileSync(join(GRAPHICS_SRC, 'index.cx16.web.8bs'), 'utf8')), layout.spriteTable);
});

test('the two web twins share their body below the shared-body line', () => {
  const below = (file) => {
    const text = readFileSync(join(GRAPHICS_SRC, file), 'utf8');
    const at = text.indexOf(SHARED);
    assert.notEqual(at, -1, `${file} has the shared-body line`);
    return text.slice(at);
  };
  assert.equal(below('index.cx16.web.8bs'), below('index.web.8bs'));
});

test('every web sprite option value is one the 128-slot table holds', () => {
  const { options } = loadCatalog('web');
  for (const id of ['sprites', 'spriteMemory']) {
    assert.ok(options[id], `the web has a ${id} option`);
    for (const value of Object.keys(options[id].values)) assert.ok(Number(value) <= 128, `${id}=${value}`);
  }
});

test('sprites=0 gives no region and leaves the agreement where it was', () => {
  for (const [machine, end] of [['hifi', 9042], ['hifi-hires', 32850]]) {
    const layout = layoutFromHardware(hardwareFor(machine, { sprites: '0' }));
    assert.equal(layout.spriteTable, -1, machine);
    assert.equal(layout.spriteCount, 0, machine);
    assert.equal(layout.reservedEnd, end, machine);
  }
});

const ART = [
  'sprite bar {',
  '  source "./bar.png"',
  '  size 16x16',
  '  transparent auto',
  '}',
  'sprite dot {',
  '  source "./dot.png"',
  '  size 8x8',
  '  transparent auto',
  '}',
  '',
].join('\n');

const PROGRAM = [
  'use @8bitscript::graphics::graphics;',
  'use self::art::{bar, dot};',
  '',
  'pub fn main() {',
  '    graphics::place(bar, 24, 16);',
  '    graphics::place(dot, 64, 40);',
  '    loop {',
  '        waitFrame();',
  '        graphics::update();',
  '    }',
  '}',
].join('\n');

function image(w, h, lit) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) if (lit(x, y)) rgba.set([255, 255, 255, 255], (y * w + x) * 4);
  }
  return encodePNG(w, h, rgba);
}

test('sprites=8 and sprites=128 draw the same pixels for the slots below 8', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-sprites-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'bar.png'), image(16, 16, (x, y) => x < 8 || y < 4));
    await writeFile(join(dir, 'dot.png'), image(8, 8, (x, y) => x + y < 8));
    await writeFile(join(dir, 'art.8bg'), ART);
    await writeFile(join(dir, 'main.8bs'), PROGRAM);
    process.chdir(dir);
    const shots = [];
    for (const count of ['8', '128']) {
      const out = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      let result;
      try {
        result = await compile('web', join(dir, 'main.8bs'), { checkout: REPO, hardware: { sprites: count } });
      } finally {
        process.stdout.write = out;
      }
      assert.equal(result.ok, true, `builds with sprites=${count}`);
      assert.equal(layoutFromHardware(result.hardware).spriteCount, Number(count));
      const shot = join(dir, `out-${count}.png`);
      await captureScreenshot('web', result.outFile, shot, { frames: 3, hardware: result.hardware });
      shots.push(await readFile(shot));
    }
    assert.ok(shots[0].equals(shots[1]), 'the same screenshot at 8 and at 128 slots');
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});
