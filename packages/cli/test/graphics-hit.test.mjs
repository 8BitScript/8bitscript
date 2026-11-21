// One program asks graphics::hit and graphics::hitAny fifty questions about five pictures and stores
// the answers in RAM, between a header and a trailer; built for the web and four --web machines it
// stores the same bytes every time. The program and the expected bytes are in graphics-hit-cases.mjs,
// which packages/c64/test/graphics-hit.test.mjs runs natively under x64sc.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { runProgram } from '../src/wasm-host.mjs';
import { layoutFromHardware, layoutForRealMachine } from '../src/web-layout.mjs';
import { ART, HEADER, LENGTH, PICTURES, expected, image, program } from './graphics-hit-cases.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PROGRAM = program();

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

const stored = expected().slice(4);

for (const { name } of TARGETS) {
  test(`${name}: the fifty answers and the trailer are the ones the boxes and positions give`, () => {
    const mem = found.get(name);
    const at = [];
    for (let i = 0; i + 4 <= mem.length; i += 1) {
      if (mem[i] === HEADER[0] && mem[i + 1] === HEADER[1] && mem[i + 2] === HEADER[2] && mem[i + 3] === HEADER[3]) at.push(i);
    }
    assert.equal(at.length, 1, `${name}: the header occurs once, at ${at}`);
    const got = [...mem.subarray(at[0] + 4, at[0] + LENGTH)];
    assert.deepEqual(got, stored, `${name}: first difference at k = ${got.findIndex((v, i) => v !== stored[i]) + 4}`);
  });
}
