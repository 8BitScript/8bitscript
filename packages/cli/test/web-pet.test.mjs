// The PET's wasm build's portable input, end to end: a real .8bs program for
// the PET is built through the wasm backend (`--web`), run in Node's
// WebAssembly, and driven the way the page drives it — the keys it hears
// poked into one byte of the program's memory between frames. No emulator is
// involved, which is why this runs in CI where the machine package's own xpet
// tests cannot (and why it exists at all: xpet has no matrix-level key
// injection, so the native layer's edge detector is held by the structure of
// its source in packages/pet/test/input.test.mjs).
//
// What it pins: natively, @8bitscript/pet/input scans PIA 1's keyboard rows,
// which on this rail are bytes nothing writes, so every key read as held
// from frame one and no press ever began — the 2048 game's frozen board in
// the editor's tab, found 2026-10-12. packages/pet/src/input.pet.web.8bs
// reads the page's snapshot byte instead, for the 40-column models and the
// 80-column 8032 alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { FrameLimitReached, instantiateProgram } from '../src/wasm-host.mjs';
import { InputEdge, layoutForRealMachine } from '../src/web-layout.mjs';
import { stockFacts } from '../src/hardware.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const SCREEN = 0x8000;

const CLI_LINE = /^(built |memory: |size breakdown|web bundle: |8bs build: )/;
function silently(fn) {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => (CLI_LINE.test(String(chunk)) ? true : out(chunk, ...rest));
  process.stderr.write = (chunk, ...rest) => (CLI_LINE.test(String(chunk)) ? true : err(chunk, ...rest));
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
  });
}

// Tallies each answer on its own row: two digits at the start of rows 0-5.
// `columns` is the width the build is fitted with, so the rows land where the
// test reads them on an 8032 too.
const inputProgram = (columns) => [
  'import { input } from "@8bitscript/input";',
  'import { screen } from "@8bitscript/screen";',
  'import { text } from "@8bitscript/text";',
  '',
  'export function main(): void {',
  '    screen.blank();',
  '    input.begin();',
  '    let confirms: usmallint = 0;',
  '    let cancels: usmallint = 0;',
  '    let lefts: usmallint = 0;',
  '    let rights: usmallint = 0;',
  '    let ups: usmallint = 0;',
  '    let downs: usmallint = 0;',
  '    while (true) {',
  '        waitFrame();',
  '        input.poll();',
  '        if (input.confirm()) { confirms++; }',
  '        if (input.cancel()) { cancels++; }',
  '        if (input.left()) { lefts++; }',
  '        if (input.right()) { rights++; }',
  '        if (input.up()) { ups++; }',
  '        if (input.down()) { downs++; }',
  '        text.printNumber(0, confirms, 2);',
  `        text.printNumber(${columns}, cancels, 2);`,
  `        text.printNumber(${columns * 2}, lefts, 2);`,
  `        text.printNumber(${columns * 3}, rights, 2);`,
  `        text.printNumber(${columns * 4}, ups, 2);`,
  `        text.printNumber(${columns * 5}, downs, 2);`,
  '    }',
  '}',
  '',
].join('\n');

/** Runs `source` on the PET's wasm build for `frames` frames: `setup(mem)` once before the program starts, then `onFrame(frame, mem)` as each waitFrame() is reached. */
async function runWithKeys(source, frames, onFrame, setup = () => {}, hardware = {}) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-pet-keys-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'main.8bs'), source);
    process.chdir(dir);
    const result = await silently(() => compile('pet', join(dir, 'main.8bs'), { checkout: REPO, web: true, hardware }));
    assert.equal(result.ok, true, 'builds for the PET through the wasm backend');
    const bytes = await readFile(result.outFile);
    let frame = 0;
    let mem = null;
    const program = await instantiateProgram(bytes, {
      waitFrame() {
        onFrame(frame, mem);
        frame += 1;
        if (frame > frames) throw new FrameLimitReached(frames);
      },
    });
    mem = new Uint8Array(program.memory.buffer);
    setup(mem);
    try {
      program.entry();
    } catch (error) {
      if (!(error instanceof FrameLimitReached)) throw error;
    }
    return mem;
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
}

/** The number the program printed in two cells at `cell`, read back out of screen memory ('0' is screen code 48). */
const printed = (mem, cell) => (mem[SCREEN + cell] - 48) * 10 + (mem[SCREEN + cell + 1] - 48);

// RETURN is already down when the program starts (set up below) and let go at
// frame 2: no press. A real press of confirm held across frames 5-7 counts
// once; a second one at frame 12. Up and down together on frame 9; cancel,
// left and right on their own frames.
const held = (frame) => {
  if (frame < 2) return InputEdge.CONFIRM;
  if (frame >= 5 && frame < 8) return InputEdge.CONFIRM;
  if (frame === 12) return InputEdge.CONFIRM;
  if (frame === 9) return InputEdge.UP | InputEdge.DOWN;
  if (frame === 14) return InputEdge.CANCEL;
  if (frame === 16) return InputEdge.LEFT;
  if (frame === 18) return InputEdge.RIGHT;
  return 0;
};

function expectTallies(mem, columns) {
  assert.equal(printed(mem, 0), 2, 'confirm: two presses, not the key down at start-up and not the frames it was held');
  assert.equal(printed(mem, columns), 1, 'cancel');
  assert.equal(printed(mem, columns * 2), 1, 'left');
  assert.equal(printed(mem, columns * 3), 1, 'right');
  assert.equal(printed(mem, columns * 4), 1, 'up');
  assert.equal(printed(mem, columns * 5), 1, 'down');
}

test("the PET wasm build's portable input reports a press once, on the frame it begins, and not a key already down at start-up", async () => {
  const layout = layoutForRealMachine('pet', { facts: stockFacts('pet') });
  assert.equal(layout.inputOffset, 1000 * 2 + 2, 'the byte the twin reads for a 40x25 grid: Video.CELL_COUNT * 2 + 2');
  const mem = await runWithKeys(inputProgram(40), 22, (frame, memory) => {
    memory[layout.inputOffset] = held(frame);
  }, (memory) => {
    memory[layout.inputOffset] = InputEdge.CONFIRM;
  });
  expectTallies(mem, 40);
});

test('the 8032 build reads the byte where its own 80x25 grid puts it, not where the 40-column one does', async () => {
  const facts = { ...stockFacts('pet'), 'video.columns': 80 };
  const layout = layoutForRealMachine('pet', { facts });
  assert.equal(layout.inputOffset, 2000 * 2 + 2, 'the byte the twin reads for an 80x25 grid: Video.CELL_COUNT * 2 + 2');
  const narrow = layoutForRealMachine('pet', { facts: stockFacts('pet') }).inputOffset;
  const mem = await runWithKeys(inputProgram(80), 22, (frame, memory) => {
    memory[layout.inputOffset] = held(frame);
    // The 40-column byte is poked with everything at once, every frame: an
    // 8032 twin reading there would tally presses this test never made.
    memory[narrow] = frame % 2 === 0 ? 0 : 63;
  }, (memory) => {
    memory[layout.inputOffset] = InputEdge.CONFIRM;
  }, { model: '8032' });
  expectTallies(mem, 80);
});
