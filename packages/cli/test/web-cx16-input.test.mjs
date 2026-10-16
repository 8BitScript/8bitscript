// The X16's wasm build's portable input, end to end: a real .8bs program for
// the X16 is built through the wasm backend (`--web`), run in Node's
// WebAssembly, and driven the way the page drives it — the keys it hears
// poked into one byte of the program's memory between frames. No emulator is
// involved, which is why this runs in CI where the X16 package's own x16emu
// tests cannot.
//
// What it pins: natively, @8bitscript/cx16/input polls the KERNAL's joystick
// and keyboard scan from asm6502 blocks, which the wasm backend never lowers,
// so any program that imported @8bitscript/input refused to build for the
// X16's wasm rail ("'input_poll': 'asm' blocks ... never lowered") — the 2048
// game in the editor's tab, found 2026-10-15. packages/cx16/src/input.cx16.web.8bs
// reads the page's snapshot byte instead, at text.CELL_COUNT * 2 + 2; this
// holds that formula, text.cx16.web.8bs's own planes and the page's layout to
// the same byte, since nothing in web-layout.mjs overrides the X16's address.
// It also holds the pointer block (a cell, a press on the frame it begins), and names the confirm
// controls as the native file does (the page reads a gamepad too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { FrameLimitReached, instantiateProgram } from '../src/wasm-host.mjs';
import { InputEdge, layoutForRealMachine } from '../src/web-layout.mjs';
import { stockFacts } from '../src/hardware.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

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

const LAYOUT = layoutForRealMachine('cx16', { facts: stockFacts('cx16') });
const COLUMNS = LAYOUT.cols;
// text.cx16.web.8bs draws its character plane here; the tallies are read back from it.
const SCREEN = LAYOUT.charBase;

// Tallies each answer on its own row: two digits at the start of rows 0-5.
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

/** Runs `source` on the X16's wasm build for `frames` frames: `setup(mem)` once before the program starts, then `onFrame(frame, mem)` as each waitFrame() is reached. */
async function runWithKeys(source, frames, onFrame, setup = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-cx16-keys-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'main.8bs'), source);
    process.chdir(dir);
    const result = await silently(() => compile('cx16', join(dir, 'main.8bs'), { checkout: REPO, web: true }));
    assert.equal(result.ok, true, 'builds for the X16 through the wasm backend: the portable input has no asm6502 left in it');
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

const TEXT_TWIN = readFileSync(resolve(REPO, 'packages', 'cx16', 'src', 'text.cx16.web.8bs'), 'utf8');
const INPUT_TWIN = readFileSync(resolve(REPO, 'packages', 'cx16', 'src', 'input.cx16.web.8bs'), 'utf8');
/** A `const NAME: type = <number>;` out of a source file. */
const constIn = (source, name) => Number(new RegExp(`const ${name}: \\w+ = (\\d+);`).exec(source)?.[1]);

test("the X16 input twin's key byte is the byte the page writes, behind text.cx16.web.8bs's two planes", () => {
  const charBase = constIn(TEXT_TWIN, 'CHAR_BASE');
  const colorBase = constIn(TEXT_TWIN, 'COLOR_BASE');
  const cells = constIn(TEXT_TWIN, 'CELL_COUNT');
  assert.equal(cells, COLUMNS * LAYOUT.rows, 'text.CELL_COUNT is the grid the layout is sized for');
  assert.equal(charBase, LAYOUT.charBase, 'the character plane is where the page reads it');
  assert.equal(colorBase, LAYOUT.colorBase, 'the colour plane is where the page reads it');
  assert.equal(colorBase + cells, LAYOUT.inputOffset, 'the input byte is one plane past the colour plane');
  // The twin's own formula, text.CELL_COUNT * 2 + 2, with the 2 being the text twin's CHAR_BASE.
  assert.match(INPUT_TWIN, /memory\.read\(text\.CELL_COUNT \* 2 \+ 2\)/);
  assert.equal(cells * 2 + charBase, LAYOUT.inputOffset);
  assert.equal(LAYOUT.inputOffset, 8514, 'on the stock 76x56 grid');
});

test("the X16 wasm build's portable input reports a press once, on the frame it begins, and not a key already down at start-up", async () => {
  const layout = LAYOUT;
  const mem = await runWithKeys(inputProgram(COLUMNS), 22, (frame, memory) => {
    memory[layout.inputOffset] = held(frame);
  }, (memory) => {
    memory[layout.inputOffset] = InputEdge.CONFIRM;
  });
  expectTallies(mem, COLUMNS);
});

test("the X16 wasm build's pointer is the page's pointer block: a cell, and a press on the frame it begins", async () => {
  const at = LAYOUT.pointerOffset;
  assert.ok(at > 0, 'the stock X16 has a mouse, so the layout carries the block');
  assert.equal(at, LAYOUT.inputOffset + 837, 'the offset the twin spells: input + 4 + 192 + 640 + 1');
  assert.match(INPUT_TWIN, /text\.CELL_COUNT \* 2 \+ 839/);
  const ROW = 11;
  const COL = 7;
  const mem = await runWithKeys([
    'import { input } from "@8bitscript/input";',
    'import { screen } from "@8bitscript/screen";',
    'import { text } from "@8bitscript/text";',
    '',
    'export function main(): void {',
    '    screen.blank();',
    '    input.begin();',
    '    let presses: usmallint = 0;',
    '    while (true) {',
    '        waitFrame();',
    '        input.poll();',
    '        if (input.pointerButton()) { presses++; }',
    '        if (input.pointer()) { text.printNumber(0, input.pointerCell(), 5); }',
    '        text.printNumber(10, presses, 2);',
    '    }',
    '}',
    '',
  ].join('\n'), 12, (frame, memory) => {
    if (frame >= 2) {
      memory[at] = 1;
      memory[at + 2] = (COL * 8 + 3) & 255;
      memory[at + 3] = (COL * 8 + 3) >> 8;
      memory[at + 4] = (ROW * 8 + 2) & 255;
      memory[at + 5] = (ROW * 8 + 2) >> 8;
    }
    // Held across frames 4-7: one press. Again at frame 10.
    memory[at + 1] = (frame >= 4 && frame < 8) || frame === 10 ? 1 : 0;
  });
  const digits = (cell, n) => Number([...Array(n).keys()].map((k) => String.fromCharCode(mem[SCREEN + cell + k])).join(''));
  assert.equal(digits(0, 5), ROW * COLUMNS + COL, 'the cell under the pointer');
  assert.equal(digits(10, 2), 2, 'two presses, not the frames each was held');
});

// The page folds a browser gamepad into the same byte (web-layout.mjs padEdges), so a
// pad's START confirms here as it does natively: the twin names the same controls.
test("the X16 wasm build names the confirm controls as the native build does: RETURN, and a pad's START", async () => {
  const mem = await runWithKeys([
    'import { Input } from "@8bitscript/input";',
    'import { screen } from "@8bitscript/screen";',
    'import { text } from "@8bitscript/text";',
    '',
    'export function main(): void {',
    '    screen.blank();',
    '    text.print(0, Input.CONFIRM_LABEL);',
    `    text.print(${COLUMNS}, Input.ALT_CONFIRM_LABEL);`,
    `    text.print(${COLUMNS * 2}, Input.CONFIRM_LABELS);`,
    '    waitFrame();',
    '}',
    '',
  ].join('\n'), 2, () => {});
  const read = (cell, length) => String.fromCharCode(...mem.subarray(SCREEN + cell, SCREEN + cell + length));
  assert.equal(read(0, 6), 'RETURN');
  assert.equal(read(COLUMNS, 5), 'START');
  assert.equal(read(COLUMNS * 2, 15), 'RETURN OR START');
  const native = readFileSync(resolve(REPO, 'packages', 'cx16', 'src', 'input.8bs'), 'utf8');
  for (const name of ['CONFIRM_LABEL', 'ALT_CONFIRM_LABEL', 'CONFIRM_LABELS']) {
    const value = (source) => new RegExp(`const ${name}: string = ("[^"]*");`).exec(source)?.[1];
    assert.equal(value(INPUT_TWIN), value(native), `Input.${name} is the native file's`);
  }
});
