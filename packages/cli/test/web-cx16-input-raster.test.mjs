// The Commander X16's wasm build, portable input and portable raster (docs/
// project/wasm-primary.md, backlog item 2): `input_poll` and `raster_commit`
// are machine code on the real machine, so before these twins any program that
// polled a key or drew a raster band failed `8bs build --target cx16 --web`.
// No emulator is involved here — a real .8bs program is built through our own
// wasm backend, run in Node's WebAssembly, and painted by the same compositor
// the browser page uses — which is why this runs in CI where the X16 package's
// own x16emu tests cannot.
//
// What this pins:
//   - the offsets the twins hard-code are the ones the page's layout computes;
//   - each twin exports the names its native file does;
//   - the input twin reports a press once, on the frame it begins, and not a key
//     already down when the program starts;
//   - the raster list applies every slot at its picture line, a list built but
//     not committed does not show, and setValue on a committed list is live;
//   - raster.frame() counts the frames the host releases, however many
//     waitFrame()s a loop pass takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { compile } from '../src/build.mjs';
import { captureScreenshot } from '../src/screenshot.mjs';
import { FrameLimitReached, instantiateProgram, runProgram } from '../src/wasm-host.mjs';
import { glyphRows } from '../src/font8x8.mjs';
import { pixelAt } from '../src/png.mjs';
import { BORDER_PX, InputEdge, VERA_PALETTE, layoutForRealMachine } from '../src/web-layout.mjs';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const CX16_FACTS = { 'video.columns': 76, 'video.rows': 56 };
const layout = layoutForRealMachine('cx16', { facts: CX16_FACTS });

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

const rgb = (hex) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
const RGB = VERA_PALETTE.map(rgb);
const same = (px, want) => px[0] === want[0] && px[1] === want[1] && px[2] === want[2];

/** Builds `source` for the X16 through the wasm backend: the compile result and the temp dir (to remove). */
async function build(source) {
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-cx16-ir-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'main.8bs'), source);
    process.chdir(dir);
    const result = await silently(() => compile('cx16', join(dir, 'main.8bs'), { checkout: REPO, web: true }));
    assert.equal(result.ok, true, 'builds for the X16 through the wasm backend');
    return { dir, result };
  } finally {
    process.chdir(prev);
  }
}

/** The screenshot of `source` after `frames` frames, as `8bs run cx16 --web --screenshot` writes it. */
async function shoot(source, { frames = 4 } = {}) {
  const { dir, result } = await build(source);
  try {
    const shot = join(dir, 'out.png');
    await captureScreenshot('cx16', result.outFile, shot, { frames, hardware: result.hardware, web: true });
    return await readFile(shot);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs `source` for `frames` frames; `onFrame(frame, mem)` fires as each waitFrame() is reached. Returns the memory. */
async function runWith(source, frames, onFrame, setup = () => {}) {
  const { dir, result } = await build(source);
  try {
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
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- the page and the twins agree on where things are -----------------------------

test("the X16 twins' offsets are the ones the page reads and writes for this machine", async () => {
  const input = await readFile(join(REPO, 'packages', 'cx16', 'src', 'input.cx16.web.8bs'), 'utf8');
  assert.equal(Number(/const INPUT_BYTE: usmallint = (\d+);/.exec(input)?.[1]), layout.inputOffset, 'the input twin reads the byte the page writes');
  const raster = await readFile(join(REPO, 'packages', 'cx16', 'src', 'rasterline.cx16.web.8bs'), 'utf8');
  const constant = (name) => Number(new RegExp(`const ${name}: usmallint = (\\d+);`).exec(raster)?.[1]);
  assert.equal(constant('LIST_CONTROL'), layout.rasterControlOffset);
  assert.equal(constant('LIST_COUNT'), layout.rasterCountOffset);
  assert.equal(constant('LIST_BASE'), layout.rasterBase);
  assert.equal(constant('FRAME_BYTE'), layout.frameOffset, 'raster.frame() reads the byte the page adds one to');
  assert.ok(layout.frameOffset >= layout.glyphBase + layout.glyphCount * 8, 'which sits past the glyph table');
  assert.equal(layout.reservedEnd, layout.frameOffset + 1, 'and program data starts above it');
  // Only the X16 pays for the byte.
  for (const target of ['c64', 'vic20', 'pet']) assert.equal(layoutForRealMachine(target, { facts: {} }).frameOffset, -1, `${target} has no frame byte`);
});

/** The names `export namespace <name> { ... }` declares: its functions and consts. */
function namespaceNames(text, name) {
  const start = text.indexOf(`export namespace ${name} {`);
  assert.notEqual(start, -1, `export namespace ${name}`);
  let depth = 0;
  let end = start;
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = text.slice(start, end);
  return {
    functions: new Set([...body.matchAll(/^\s{4}function (\w+)\(/gm)].map((m) => m[1])),
    consts: new Set([...body.matchAll(/^\s{4}const (\w+):/gm)].map((m) => m[1])),
  };
}

test("each X16 wasm twin exports the names its native file does", async () => {
  const src = (file) => readFile(join(REPO, 'packages', 'cx16', 'src', file), 'utf8');
  const [nativeInput, twinInput, nativeRaster, twinRaster] = await Promise.all([
    src('input.8bs'), src('input.cx16.web.8bs'), src('rasterline.8bs'), src('rasterline.cx16.web.8bs'),
  ]);
  // input: the whole portable surface, both namespaces.
  for (const space of ['input', 'Input']) {
    const a = namespaceNames(nativeInput, space);
    const b = namespaceNames(twinInput, space);
    assert.deepEqual([...b.functions].sort(), [...a.functions].sort(), `input.cx16.web.8bs: ${space} functions`);
    assert.deepEqual([...b.consts].sort(), [...a.consts].sort(), `input.cx16.web.8bs: ${space} consts`);
  }
  // raster: the portable calls and constants. The native file has helpers of its
  // own in the same namespace (place, copyLine, the palette and gap painters) that
  // belong to the VERA handler and have no meaning without it.
  const portableCalls = ['clear', 'at', 'insert', 'count', 'commit', 'setValue', 'enable', 'frame', 'disable'];
  const portableConsts = ['ENTRIES', 'STRIDE', 'FINE_SCROLL', 'COLORS', 'CHARSET', 'FRAME_COUNTER', 'ALT_TILEBASE'];
  const a = namespaceNames(nativeRaster, 'raster');
  const b = namespaceNames(twinRaster, 'raster');
  for (const name of portableCalls) {
    assert.ok(a.functions.has(name), `native rasterline.8bs has ${name}`);
    assert.ok(b.functions.has(name), `rasterline.cx16.web.8bs has ${name}`);
  }
  for (const name of portableConsts) {
    assert.ok(a.consts.has(name), `native rasterline.8bs has ${name}`);
    assert.ok(b.consts.has(name), `rasterline.cx16.web.8bs has ${name}`);
  }
  const slots = (text) => [...namespaceNames(text, 'Slot').consts].sort();
  assert.deepEqual(slots(twinRaster), slots(nativeRaster), 'the same Slot names');
  // And the same numbers where a program reads them.
  const value = (text, name) => new RegExp(`const ${name}: \\w+ = ([^;]+);`).exec(text)?.[1];
  for (const name of ['ENTRIES', 'STRIDE', 'FINE_SCROLL', 'COLORS', 'CHARSET', 'FRAME_COUNTER']) {
    assert.equal(value(twinRaster, name), value(nativeRaster, name), `raster.${name} is the machine's`);
  }
});

// ---- portable input ----------------------------------------------------------------

const INPUT_PROGRAM = [
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
  '    let width: usmallint = text.COLUMNS;',
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
  '        text.printNumber(width, cancels, 2);',
  '        text.printNumber(width * 2, lefts, 2);',
  '        text.printNumber(width * 3, rights, 2);',
  '        text.printNumber(width * 4, ups, 2);',
  '        text.printNumber(width * 5, downs, 2);',
  '    }',
  '}',
  '',
].join('\n');

/** The number the program printed in two cells at `cell`, read back out of the character plane ('0' is 48). */
const printed = (mem, cell) => (mem[layout.charBase + cell] - 48) * 10 + (mem[layout.charBase + cell + 1] - 48);

test("the X16 wasm build's portable input reports a press once, on the frame it begins, and not a key already down at start-up", async () => {
  const held = (frame) => {
    // Enter is already down when the program starts and let go at frame 2: no press.
    if (frame < 2) return InputEdge.CONFIRM;
    // A real press of confirm held across frames 5-7 counts once; a second one at frame 12.
    if (frame >= 5 && frame < 8) return InputEdge.CONFIRM;
    if (frame === 12) return InputEdge.CONFIRM;
    // Up and down together on frame 9; cancel, left and right on their own frames.
    if (frame === 9) return InputEdge.UP | InputEdge.DOWN;
    if (frame === 14) return InputEdge.CANCEL;
    if (frame === 16) return InputEdge.LEFT;
    if (frame === 18) return InputEdge.RIGHT;
    return 0;
  };
  const columns = 76;
  const mem = await runWith(INPUT_PROGRAM, 22, (frame, memory) => {
    memory[layout.inputOffset] = held(frame);
  }, (memory) => {
    memory[layout.inputOffset] = InputEdge.CONFIRM;
  });
  assert.equal(printed(mem, 0), 2, 'confirm: two presses, not the key down at start-up and not the frames it was held');
  assert.equal(printed(mem, columns), 1, 'cancel');
  assert.equal(printed(mem, columns * 2), 1, 'left');
  assert.equal(printed(mem, columns * 3), 1, 'right');
  assert.equal(printed(mem, columns * 4), 1, 'up');
  assert.equal(printed(mem, columns * 5), 1, 'down');
});

test("the X16 wasm build's pointer answers false: the page does not carry a mouse to the program", async () => {
  const mem = await runWith([
    'import { input } from "@8bitscript/input";',
    'import { screen } from "@8bitscript/screen";',
    'import { text } from "@8bitscript/text";',
    '',
    'export function main(): void {',
    '    screen.blank();',
    '    input.begin();',
    '    waitFrame();',
    '    input.poll();',
    '    if (input.pointer()) { text.print(0, "P"); } else { text.print(0, "N"); }',
    '    if (input.pointerButton()) { text.print(1, "B"); } else { text.print(1, "N"); }',
    '    waitFrame();',
    '}',
    '',
  ].join('\n'), 3, () => {});
  assert.equal(mem[layout.charBase], 'N'.charCodeAt(0), 'no pointer');
  assert.equal(mem[layout.charBase + 1], 'N'.charCodeAt(0), 'no button');
});

// ---- the portable raster list --------------------------------------------------------

const RASTER_PROGRAM = [
  'import { screen, BorderColor, BackgroundColor } from "@8bitscript/screen";',
  'import { text, TextColor } from "@8bitscript/text";',
  'import { raster, Slot } from "@8bitscript/raster";',
  '',
  'export function main(): void {',
  '    screen.blank(BorderColor.GREEN, BackgroundColor.BLACK);',
  '    text.setColor(TextColor.WHITE);',
  '    let width: usmallint = text.COLUMNS;',
  '    text.print(width * 10, "scroll");',
  '    text.print(width * 11, "scroll");',
  '    text.print(width * 14, "abc");',
  '    text.print(width * 15, "abc");',
  '    text.print(width * 16, "abc");',
  '    raster.clear();',
  '    raster.at(40, Slot.BORDER, BorderColor.RED);',
  '    raster.at(40, Slot.BACKGROUND, BackgroundColor.BLUE);',
  '    raster.at(80, Slot.SCROLL_X, 3);',
  '    raster.at(100, Slot.SCROLL_X, 0);',
  '    raster.at(120, Slot.CHARSET, 1);',
  '    raster.at(140, Slot.CHARSET, 0);',
  '    raster.at(160, Slot.BORDER, BorderColor.GREEN);',
  '    raster.at(160, Slot.BACKGROUND, BackgroundColor.BLACK);',
  '    raster.enable();',
  '    while (true) {',
  '        waitFrame();',
  '    }',
  '}',
  '',
].join('\n');

/** The pixel at (x, y) of cell (col, row)'s glyph box, in the picture. */
const cellPixel = (png, col, row, x, y) => pixelAt(png, BORDER_PX + col * 8 + x, BORDER_PX + row * 8 + y);

/** True if cell (col, row) shows `code` in set `charset`: ink where the glyph is, `paper` elsewhere, shifted `shift` pixels right. */
function cellIs(png, col, row, code, charset, ink, paper, shift = 0) {
  const rows = glyphRows(code, layout.font, charset);
  for (let gy = 0; gy < 8; gy += 1) {
    for (let gx = 0; gx < 8; gx += 1) {
      const on = ((rows[gy] >> gx) & 1) !== 0;
      const px = pixelAt(png, BORDER_PX + col * 8 + gx + shift, BORDER_PX + row * 8 + gy);
      if (!same(px, on ? ink : paper)) return false;
    }
  }
  return true;
}

test('the portable raster list on the X16 wasm build applies each slot at its picture line: colours, fine scroll, character set', async () => {
  const png = await shoot(RASTER_PROGRAM);
  const [black, white, red, , , green, blue] = RGB;
  // BORDER at line 40 and back at 160: the border strip changes exactly there.
  assert.ok(same(pixelAt(png, 2, BORDER_PX + 39), green), "border above line 40: the program's green");
  assert.ok(same(pixelAt(png, 2, BORDER_PX + 40), red), 'border from line 40: red');
  assert.ok(same(pixelAt(png, 2, BORDER_PX + 159), red), 'still red on line 159');
  assert.ok(same(pixelAt(png, 2, BORDER_PX + 160), green), 'green again from line 160');
  // BACKGROUND likewise: a blank cell above the band is black, inside it blue, below it black.
  assert.ok(same(cellPixel(png, 60, 4, 3, 3), black), 'cell row 4 (lines 32-39): black');
  assert.ok(same(cellPixel(png, 60, 5, 3, 3), blue), 'cell row 5 (lines 40-47): blue');
  assert.ok(same(cellPixel(png, 60, 19, 3, 3), blue), 'cell row 19 (lines 152-159): blue');
  assert.ok(same(cellPixel(png, 60, 20, 3, 3), black), 'cell row 20 (lines 160-167): black again');
  // SCROLL_X 3 on lines 80-99: "scroll" on cell rows 10 and 11 sits three pixels right, its first three columns blue.
  [...'scroll'].forEach((ch, col) => {
    for (const row of [10, 11]) {
      assert.ok(cellIs(png, col, row, ch.charCodeAt(0), 0, white, blue, 3), `row ${row} col ${col}: '${ch}' shifted by 3`);
    }
  });
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      assert.ok(same(pixelAt(png, BORDER_PX + x, BORDER_PX + 80 + y), blue), `a scrolled line opens its first pixels as background (${x}, ${80 + y})`);
    }
  }
  // CHARSET 1 on lines 120-139: the same "abc" is lower case on row 14 and capitals on rows 15 and 16.
  [...'abc'].forEach((ch, col) => {
    assert.ok(cellIs(png, col, 14, ch.charCodeAt(0), 0, white, blue), `row 14: '${ch}' in the boot set`);
    assert.ok(cellIs(png, col, 15, ch.charCodeAt(0), 1, white, blue), 'row 15: the same code in the alternate set');
    assert.ok(cellIs(png, col, 16, ch.charCodeAt(0), 1, white, blue), 'row 16: and again');
  });
});

test('a raster list that is built but not committed does not show, and setValue on a committed one is live', async () => {
  const program = (finish) => [
    'import { screen, BorderColor, BackgroundColor } from "@8bitscript/screen";',
    'import { raster, Slot } from "@8bitscript/raster";',
    '',
    'export function main(): void {',
    '    screen.blank(BorderColor.GREEN, BackgroundColor.BLACK);',
    '    raster.clear();',
    '    raster.at(40, Slot.BORDER, BorderColor.RED);',
    '    raster.enable();',
    '    waitFrame();',
    finish,
    '    while (true) {',
    '        waitFrame();',
    '    }',
    '}',
    '',
  ].join('\n');
  const red = RGB[2];
  const green = RGB[5];
  const blue = RGB[6];
  // After enable() the band shows. Rebuilding the list without commit() changes nothing on screen.
  let png = await shoot(program('    raster.clear();\n    raster.at(100, Slot.BORDER, BorderColor.BLUE);'));
  assert.ok(same(pixelAt(png, 2, BORDER_PX + 40), red), 'the committed list still shows');
  assert.ok(same(pixelAt(png, 2, BORDER_PX + 100), red), 'and the rebuilt one, not yet committed, does not');
  // The same rebuild with commit() takes over.
  png = await shoot(program('    raster.clear();\n    raster.at(100, Slot.BORDER, BorderColor.BLUE);\n    raster.commit();'));
  assert.ok(same(pixelAt(png, 2, BORDER_PX + 40), green), 'committed: nothing at line 40 now');
  assert.ok(same(pixelAt(png, 2, BORDER_PX + 100), blue), 'and the new band at line 100');
  // setValue on a committed list needs no commit.
  png = await shoot(program('    raster.setValue(0, BorderColor.BLUE);'));
  assert.ok(same(pixelAt(png, 2, BORDER_PX + 40), blue), 'setValue changed the live entry at once');
  // But on a list that has changed since its commit it edits the program's copy only: what shows keeps showing.
  png = await shoot(program('    raster.clear();\n    raster.at(100, Slot.BORDER, BorderColor.GREEN);\n    raster.setValue(0, BorderColor.BLUE);'));
  assert.ok(same(pixelAt(png, 2, BORDER_PX + 40), red), 'the live list is untouched until the next commit()');
  // And a bad offset or slot is refused, as natively.
  const mem = await runWith([
    'import { raster, Slot } from "@8bitscript/raster";',
    'import { screen } from "@8bitscript/screen";',
    'import { text } from "@8bitscript/text";',
    '',
    'export function main(): void {',
    '    screen.blank();',
    '    raster.clear();',
    '    if (raster.at(40, 9, 1)) { text.print(0, "A"); } else { text.print(0, "a"); }',
    '    raster.at(50, Slot.BORDER, 1);',
    '    if (raster.at(49, Slot.BORDER, 2)) { text.print(1, "B"); } else { text.print(1, "b"); }',
    '    if (raster.setValue(1, 3)) { text.print(2, "C"); } else { text.print(2, "c"); }',
    '    if (raster.setValue(0, 3)) { text.print(3, "D"); } else { text.print(3, "d"); }',
    '    if (raster.insert(10, Slot.BORDER, 2)) { text.print(4, "E"); } else { text.print(4, "e"); }',
    '    text.printNumber(10, raster.count(), 2);',
    '    waitFrame();',
    '}',
    '',
  ].join('\n'), 2, () => {});
  const chars = (cell) => String.fromCharCode(mem[layout.charBase + cell]);
  assert.equal(chars(0), 'a', 'an unknown slot is refused');
  assert.equal(chars(1), 'b', 'a line above the last entry is refused by at()');
  assert.equal(chars(2), 'c', 'a setValue offset that is not a multiple of the stride is refused');
  assert.equal(chars(3), 'D', 'a setValue on an entry that exists is taken');
  assert.equal(chars(4), 'E', 'insert slides an entry into place at any line');
  assert.equal(printed(mem, 10), 2, 'two entries in the list');
});

// ---- raster.frame() -------------------------------------------------------------------

/** Which digit glyph, 0-9, cell (col, row) shows in the picture, or -1. */
function digitAt(png, col, row) {
  for (let d = 0; d < 10; d += 1) {
    const rows = glyphRows(48 + d, layout.font, 0);
    let ok = true;
    for (let gy = 0; gy < 8 && ok; gy += 1) {
      for (let gx = 0; gx < 8; gx += 1) {
        const on = ((rows[gy] >> gx) & 1) !== 0;
        const px = cellPixel(png, col, row, gx, gy);
        if (!same(px, on ? RGB[1] : RGB[0])) { ok = false; break; }
      }
    }
    if (ok) return d;
  }
  return -1;
}

const FRAME_PROGRAM = (inner) => [
  'import { screen } from "@8bitscript/screen";',
  'import { text } from "@8bitscript/text";',
  'import { raster, Slot } from "@8bitscript/raster";',
  '',
  'export function main(): void {',
  '    screen.blank();',
  '    raster.clear();',
  '    raster.at(0, Slot.BORDER, 0);',
  '    raster.enable();',
  '    let seen: utinyint = 0;',
  inner,
  '    text.printNumber(0, raster.frame(), 2);',
  '    if (raster.FRAME_COUNTER) { text.print(10, "T"); } else { text.print(10, "F"); }',
  '    while (true) {',
  '        waitFrame();',
  '    }',
  '}',
  '',
].join('\n');

test("raster.frame() counts the frames the host releases, however many waitFrame()s a loop pass takes", async () => {
  // Five passes of one frame: five frames. The headless host adds one to the page's frame byte for every
  // frame it releases, as the browser page does, so the screenshot reads what a person would.
  let png = await shoot(FRAME_PROGRAM('    for (let pass: utinyint = 0; pass < 5; pass++) { waitFrame(); }'), { frames: 30 });
  assert.equal(digitAt(png, 0, 0) * 10 + digitAt(png, 1, 0), 5, 'five frames after enable()');
  // Four passes of three: twelve. The count is the host's, not the loop's.
  png = await shoot(FRAME_PROGRAM('    for (let pass: utinyint = 0; pass < 4; pass++) { waitFrame(); waitFrame(); waitFrame(); }'), { frames: 30 });
  assert.equal(digitAt(png, 0, 0) * 10 + digitAt(png, 1, 0), 12, 'twelve frames, however the loop slices them');
  assert.equal(cellIs(png, 10, 0, 'T'.charCodeAt(0), 0, RGB[1], RGB[0]), true, 'and FRAME_COUNTER says it counts');
  // Frames that pass before enable() are not counted: it is "since enable()", as on the machine.
  png = await shoot([
    'import { screen } from "@8bitscript/screen";',
    'import { text } from "@8bitscript/text";',
    'import { raster, Slot } from "@8bitscript/raster";',
    '',
    'export function main(): void {',
    '    screen.blank();',
    '    for (let pass: utinyint = 0; pass < 7; pass++) { waitFrame(); }',
    '    raster.clear();',
    '    raster.at(0, Slot.BORDER, 0);',
    '    raster.enable();',
    '    for (let pass: utinyint = 0; pass < 3; pass++) { waitFrame(); }',
    '    text.printNumber(0, raster.frame(), 2);',
    '    while (true) {',
    '        waitFrame();',
    '    }',
    '}',
    '',
  ].join('\n'), { frames: 30 });
  assert.equal(digitAt(png, 0, 0) * 10 + digitAt(png, 1, 0), 3, 'three frames since enable(), not ten since the program began');
});

test('the headless host releases frames to its onFrame hook, counting from 1, before the program resumes', async () => {
  const { dir, result } = await build('export function main(): void {\n    while (true) {\n        waitFrame();\n    }\n}\n');
  try {
    const bytes = await readFile(result.outFile);
    const seen = [];
    await runProgram(bytes, { frames: 4, onFrame: (memory, frame) => { seen.push([frame, memory instanceof Uint8Array]); } });
    assert.deepEqual(seen.map((s) => s[0]), [1, 2, 3, 4, 5], 'one call for every waitFrame(), including the one that ends the run');
    assert.ok(seen.every((s) => s[1]), 'with the program memory');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
