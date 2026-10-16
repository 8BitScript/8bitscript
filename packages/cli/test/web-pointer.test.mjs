// The pointer block, end to end through the wasm backend: a real program
// reads input.pointer(), pointerCell() and pointerButton() on the Modern web
// host and on the C64's wasm build with a 1351 fitted, while the page's
// writes are poked into the program's memory between frames. Where a
// machine has no mouse — a web skin, a stock C64 — the same program must
// see none, and the block must not exist. See web-layout.mjs PointerRegister.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { FrameLimitReached, instantiateProgram } from '../src/wasm-host.mjs';
import { layoutForRealMachine, layoutFromHardware } from '../src/web-layout.mjs';

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

// Prints the pointer cell (5 digits) at cell 0 and the press count (2) at cell 10, or "N" at 0 with no pointer.
const PROGRAM = [
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
  '        if (input.pointer()) { text.printNumber(0, input.pointerCell(), 5); } else { text.print(0, "N"); }',
  '        text.printNumber(10, presses, 2);',
  '    }',
  '}',
  '',
].join('\n');

async function run(target, options, layoutOf, poke) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-pointer-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'main.8bs'), PROGRAM);
    process.chdir(dir);
    const result = await silently(() => compile(target, join(dir, 'main.8bs'), { checkout: REPO, ...options }));
    assert.equal(result.ok, true, `${target} builds`);
    const layout = layoutOf(result);
    const bytes = await readFile(result.outFile);
    let frame = 0;
    let mem = null;
    const program = await instantiateProgram(bytes, {
      waitFrame() {
        poke(frame, mem, layout);
        frame += 1;
        if (frame > 12) throw new FrameLimitReached(12);
      },
    });
    mem = new Uint8Array(program.memory.buffer);
    try {
      program.entry();
    } catch (error) {
      if (!(error instanceof FrameLimitReached)) throw error;
    }
    return { mem, layout };
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
}

const COL = 9;
const ROW = 6;
function poker(columns) {
  return (frame, mem, layout) => {
    const at = layout.pointerOffset;
    if (at < 0) return;
    if (frame >= 2) {
      mem[at] = 1;
      mem[at + 2] = (COL * 8 + 1) & 255;
      mem[at + 3] = (COL * 8 + 1) >> 8;
      mem[at + 4] = (ROW * 8 + 5) & 255;
      mem[at + 5] = (ROW * 8 + 5) >> 8;
    }
    mem[at + 1] = (frame >= 4 && frame < 8) || frame === 10 ? 1 : 0;
  };
}
const digits = (mem, layout, cell, n) => Number([...Array(n).keys()].map((k) => String.fromCharCode(mem[layout.charBase + cell + k])).join(''));

test('the Modern web host: pointer() is the page\'s block, a cell under it, and a press once', async () => {
  const { mem, layout } = await run('web', { hardware: {} }, () => layoutFromHardware({ facts: {}, options: { machine: 'hifi' } }), poker(48));
  assert.ok(layout.pointerOffset > 0);
  assert.equal(digits(mem, layout, 0, 5), ROW * 48 + COL);
  assert.equal(digits(mem, layout, 10, 2), 2);
});

test('a web skin is a machine with no mouse: the same program sees none', async () => {
  const { mem, layout } = await run('web', { hardware: { machine: 'c64' } }, () => layoutFromHardware({ facts: {}, options: { machine: 'c64' } }), () => {});
  assert.equal(layout.pointerOffset, -1);
  assert.equal(String.fromCharCode(mem[layout.charBase]), 'N');
});

test('the C64 wasm build has a pointer only with a 1351 fitted, and never draws an arrow of its own', async () => {
  const stock = await run('c64', { web: true }, (r) => layoutForRealMachine('c64', r.hardware), () => {});
  assert.equal(stock.layout.pointerOffset, -1, 'a stock C64 has no mouse');
  assert.equal(String.fromCharCode(stock.mem[stock.layout.charBase]), 'N');
  const mouse = await run('c64', { web: true, hardware: { port1: 'mouse1351' } }, (r) => layoutForRealMachine('c64', r.hardware), poker(40));
  assert.equal(mouse.layout.pointerOffset, 2198, 'where input.c64.web.8bs reads it');
  assert.equal(digits(mouse.mem, mouse.layout, 0, 5), ROW * 40 + COL);
  assert.equal(digits(mouse.mem, mouse.layout, 10, 2), 2);
});
