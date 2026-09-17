// The Modern (resizable) web host sizes its register map for the largest
// grid it will ever hand out, so its agreement runs to 8392 — and the wasm
// backend's data section used to start at a fixed 8192, inside it. A real
// program's first string literal landed under INPUT_OFFSET (8196): 2048's
// "v0.2.0" put its '2' exactly there, so the page's input writes turned the
// title into "v0. .0" and the program booted reading '2' (RIGHT + CONFIRM +
// CANCEL) as the player's input. This builds that program for real, boots
// it in the same host `8bs run web --screenshot` uses, and looks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { instantiateProgram } from '../src/wasm-host.mjs';
import { layoutFromHardware } from '../src/web-layout.mjs';

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

const VERSION = 'v0.2.0';
const PROGRAM = [
  'import { screen } from "@8bitscript/screen";',
  'import { text } from "@8bitscript/text";',
  'import { input } from "@8bitscript/input";',
  '',
  `const VERSION_LINE: string = "${VERSION}";`,
  '',
  'export function main(): void {',
  '    screen.blank();',
  '    input.begin();',
  '    input.poll();',
  '    // The first frame\'s input, before the page has written anything: on',
  '    // the broken layout this read the string\'s own bytes. Reported on',
  '    // the screen (an X at cell 10) because an entry may export only main.',
  '    if (input.left() || input.right() || input.confirm()) {',
  '        text.putChar(10, 24);',
  '    }',
  '    text.print(0, VERSION_LINE);',
  '    text.releaseCursor();',
  '}',
  '',
].join('\n');

async function buildFor(machine) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-overlap-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'main.8bs'), PROGRAM);
    process.chdir(dir);
    const hardware = machine ? { machine } : {};
    const result = await silently(() => compile('web', join(dir, 'main.8bs'), { checkout: REPO, hardware }));
    assert.equal(result.ok, true, `builds for ${machine ?? 'the Modern host'}`);
    return { bytes: await readFile(result.outFile), layout: layoutFromHardware(result.hardware) };
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
}

function findString(memory, from) {
  const wanted = [VERSION.length, ...Buffer.from(VERSION)];
  for (let a = from; a < memory.length - wanted.length; a++) {
    if (wanted.every((b, i) => memory[a + i] === b)) return a;
  }
  return -1;
}

test('on the Modern host, a program\'s first string literal sits past the register agreement, and the first frame\'s input is idle', async () => {
  const { bytes, layout } = await buildFor(undefined);
  assert.equal(layout.resizable, true);
  assert.equal(layout.inputOffset, 8196);
  const { memory: wasmMemory, entry } = await instantiateProgram(bytes, { waitFrame: () => {} });
  const memory = new Uint8Array(wasmMemory.buffer);
  // Before the program runs: the whole agreement is zero, so the input byte
  // reads idle and the raster control byte reads "no list".
  for (let a = layout.inputOffset; a < layout.reservedEnd; a++) {
    assert.equal(memory[a], 0, `agreement byte ${a} is clear at boot`);
  }
  const at = findString(memory, 0);
  assert.ok(at >= layout.reservedEnd, `"${VERSION}" is laid out at ${at}, past the agreement's end ${layout.reservedEnd}`);
  entry();
  assert.equal(memory[layout.charBase + 10], 32, 'the first frame saw no input: the blanked cell 10 holds a space, not the X');
  // The title was printed from an intact literal: "v0.2.0" at cell 0 (the
  // web text package keeps ASCII as it is — no screen-code conversion).
  const cells = [...memory.slice(layout.charBase, layout.charBase + VERSION.length)];
  assert.deepEqual(cells, [...Buffer.from(VERSION)]);
  // Now what the page does every frame — input, host status, a raster list
  // — and the literal is still what it was.
  memory[layout.inputOffset] = 0xff;
  memory[layout.hostOffset] = 1;
  memory[layout.rasterControlOffset] = 1;
  memory[layout.rasterCountOffset] = layout.rasterMaxEntries;
  memory.fill(0xee, layout.rasterBase, layout.reservedEnd);
  assert.equal(findString(memory, layout.reservedEnd), at, 'the literal did not move and was not overwritten');
});

test('a fixed web skin keeps its data where it always was', async () => {
  const { bytes, layout } = await buildFor('c64');
  assert.equal(layout.resizable, false);
  const { memory: wasmMemory } = await instantiateProgram(bytes, { waitFrame: () => {} });
  const memory = new Uint8Array(wasmMemory.buffer);
  assert.equal(findString(memory, 0), 8192, 'the fixed skins\' agreement ends far below the floor: byte-identical layout to before');
});
