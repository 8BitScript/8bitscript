// One program asks graphics::hit and graphics::hitAny twenty-three questions about four pictures and
// stores the answers in RAM; built for the web and four --web machines it stores the same twenty-three
// bytes every time. The expected column is worked out here from the box rule (the pixels with
// alpha >= 16, over every frame) and the positions, not read from another build.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { encodePNG } from '../src/png.mjs';
import { runProgram } from '../src/wasm-host.mjs';
import { layoutFromHardware, layoutForRealMachine } from '../src/web-layout.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

function image(w, h, opaque) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) if (opaque(x, y)) rgba.set([255, 255, 255, 255], (y * w + x) * 4);
  }
  return encodePNG(w, h, rgba);
}

// Slots 0 to 3, in this order. `two` is a 32x16 source, two frames of 16x16.
const PICTURES = [
  { name: 'solid', w: 16, h: 16, size: 16, opaque: () => true },
  { name: 'margin', w: 16, h: 16, size: 16, opaque: (x, y) => x >= 3 && x <= 12 && y >= 3 && y <= 12 },
  { name: 'blank', w: 8, h: 8, size: 8, opaque: () => false },
  { name: 'two', w: 32, h: 16, size: 16, opaque: (x, y) => (x < 16 ? x < 4 && y < 8 : x >= 28 && y >= 8) },
];

const ART = PICTURES.map(({ name, size }) => `sprite ${name} {\n  source "./${name}.png"\n  size ${size}x${size}\n  transparent auto\n}\n`).join('');

const HEADER = [165, 90, 195, 60];

// [k, what is placed before the call, the statement, the stored byte]
const CASES = [
  [4, 'place(solid, 40, 40); place(margin, 50, 50);', 'yes(4, graphics::hit(solid, margin));', 1],
  [5, 'place(solid, 40, 40); place(margin, 53, 40);', 'yes(5, graphics::hit(solid, margin));', 2],
  [6, 'place(solid, 40, 40); place(margin, 52, 40);', 'yes(6, graphics::hit(solid, margin));', 1],
  [7, 'place(solid, 40, 40); place(two, 28, 40);', 'yes(7, graphics::hit(solid, two));', 1],
  [8, 'place(solid, 40, 40); place(two, 53, 40);', 'yes(8, graphics::hit(solid, two));', 1],
  [9, 'place(solid, 40, 40); place(two, 56, 40);', 'yes(9, graphics::hit(solid, two));', 2],
  [10, 'place(solid, 40, 40); place(margin, 50, 50); graphics::hide(margin);', 'yes(10, graphics::hit(solid, margin));', 2],
  [11, 'place(solid, 40, 40);', 'yes(11, graphics::hit(solid, solid));', 2],
  [12, 'place(solid, 40, 40);', 'yes(12, graphics::hit(solid, blank));', 2],
  [13, 'place(solid, 40, 40); place(blank, 40, 40);', 'yes(13, graphics::hit(solid, blank));', 2],
  [14, 'place(solid, 40, 40);', 'yes(14, graphics::hit(solid, 200));', 2],
  [15, 'place(solid, 40, 40); place(margin, 50, 50); graphics::hide(margin); place(margin, 50, 50);', 'yes(15, graphics::hit(solid, margin));', 1],
  [16, 'place(solid, 1000, 1000); place(margin, 1000, 1000);', 'yes(16, graphics::hit(solid, margin));', 1],
  [17, 'place(solid, 41, 41); place(margin, 54, 41);', 'yes(17, graphics::hit(solid, margin));', 2],
  [18, 'place(solid, 40, 40); place(margin, 50, 50); place(two, 45, 45);', 'answers[18] = graphics::hitAny(solid);', 1],
  [19, 'place(solid, 40, 40);', 'answers[19] = graphics::hitAny(solid);', 255],
  [20, 'place(solid, 40000, 10); place(margin, 40000, 10);', 'yes(20, graphics::hit(solid, margin));', 2],
  [21, 'place(solid, 40, 40); place(margin, 27, 40);', 'yes(21, graphics::hit(solid, margin));', 2],
  [22, 'place(solid, 40, 40); place(margin, 28, 40);', 'yes(22, graphics::hit(solid, margin));', 1],
  [23, 'place(solid, 40, 40); place(margin, 40, 27);', 'yes(23, graphics::hit(solid, margin));', 2],
  [24, 'place(solid, 40, 40); place(margin, 40, 28);', 'yes(24, graphics::hit(solid, margin));', 1],
  [25, 'place(solid, 40, 40); place(margin, 40, 53);', 'yes(25, graphics::hit(solid, margin));', 2],
  [26, 'place(solid, 40, 40); place(margin, 40, 52);', 'yes(26, graphics::hit(solid, margin));', 1],
];

const PROGRAM = [
  'use @8bitscript::graphics::graphics;',
  `use self::art::{${PICTURES.map((p) => p.name).join(', ')}};`,
  '',
  'let mut answers: [u8; 27];',
  '',
  'fn reset() {',
  ...PICTURES.map((p) => `    graphics::hide(${p.name});`),
  '}',
  '',
  'fn yes(k: utinyint, on: bool) {',
  '    if on {',
  '        answers[k] = 1;',
  '    } else {',
  '        answers[k] = 2;',
  '    }',
  '}',
  '',
  'pub fn main() {',
  ...HEADER.map((v, i) => `    answers[${i}] = ${v};`),
  ...CASES.flatMap(([, before, call]) => [`    ${before.replace(/(?<![:\w])place\(/g, 'graphics::place(')}`, `    ${call}`, '    reset();']),
  '    loop {',
  '        waitFrame();',
  '        graphics::update();',
  '    }',
  '}',
].join('\n');

const TARGETS = [
  { name: 'web (hifi)', build: (e) => compile('web', e, { checkout: REPO, hardware: { machine: 'hifi' } }), real: null },
  { name: 'cx16 --web', build: (e) => compile('cx16', e, { checkout: REPO, web: true }), real: 'cx16' },
  { name: 'c64 --web', build: (e) => compile('c64', e, { checkout: REPO, web: true }), real: 'c64' },
  { name: 'pet --web', build: (e) => compile('pet', e, { checkout: REPO, web: true }), real: 'pet' },
  { name: 'vic20 --web', build: (e) => compile('vic20', e, { checkout: REPO, web: true }), real: 'vic20' },
];

const found = new Map();
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), '8bs-graphics-hit-'));
  const prev = process.cwd();
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  try {
    for (const { name, w, h, opaque } of PICTURES) await writeFile(join(dir, `${name}.png`), image(w, h, opaque));
    await writeFile(join(dir, 'art.8bg'), ART);
    await writeFile(join(dir, 'main.8bs'), PROGRAM);
    process.chdir(dir);
    for (const target of TARGETS) {
      process.stdout.write = () => true;
      process.stderr.write = () => true;
      let result;
      try {
        result = await target.build(join(dir, 'main.8bs'));
      } finally {
        process.stdout.write = out;
        process.stderr.write = err;
      }
      assert.equal(result.ok, true, `${target.name} builds`);
      const layout = target.real ? layoutForRealMachine(target.real, result.hardware) : layoutFromHardware(result.hardware);
      const onFrame = layout.frameOffset >= 0 ? (memory, frame) => { memory[layout.frameOffset] = frame & 255; } : undefined;
      const { memory } = await runProgram(await readFile(result.outFile), { frames: 3, onFrame });
      found.set(target.name, new Uint8Array(memory.buffer));
    }
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    process.chdir(prev);
  }
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const stored = new Array(23).fill(0);
for (const [k, , , value] of CASES) stored[k - 4] = value;

for (const { name } of TARGETS) {
  test(`${name}: the twenty-three answers are the ones the boxes and positions give`, () => {
    const mem = found.get(name);
    const at = [];
    for (let i = 0; i + 4 <= mem.length; i += 1) {
      if (mem[i] === HEADER[0] && mem[i + 1] === HEADER[1] && mem[i + 2] === HEADER[2] && mem[i + 3] === HEADER[3]) at.push(i);
    }
    assert.equal(at.length, 1, `${name}: the header occurs once, at ${at}`);
    const got = [...mem.subarray(at[0] + 4, at[0] + 27)];
    assert.deepEqual(got, stored, `${name}: first difference at k = ${got.findIndex((v, i) => v !== stored[i]) + 4}`);
  });
}
