// The C64's hardware layers, run for real under x64sc: the raster list,
// the wobble band over raster.setValue, idle graphics, the opened border,
// the sprite multiplexer, bitmap mode, the region probe, and REU
// transfers. Each probe program links clean for the C64 without
// an emulator; each is also run headless and its screenshot read at a
// few pixels — the probe encodes its answer in colors, as
// test/reu-probe.8bs does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';
import { pixelAt } from '../../cli/src/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');

const PROBES = {
  raster: ['raster-probe.8bs', ['raster_at', 'raster_enable']],
  idle: ['idle-probe.8bs', ['idle_ghost', 'scroll_setY', 'raster_enable']],
  border: ['border-probe.8bs', ['border_top', 'border_bottom', 'idle_setPattern', 'raster_insert']],
  multiplex: ['multiplex-probe.8bs', ['multiplex_update', 'multiplex_set', 'raster_commit', 'raster_setFrameByte']],
  wobble: ['wobble-probe.8bs', ['raster_at', 'raster_setValue', 'raster_enable']],
  bitmap: ['bitmap-probe.8bs', ['bitmap_enter', 'bitmap_plot', 'bitmap_fillColors', 'sprites_setShapeByte']],
  region: ['region-probe.8bs', ['detectRegion', 'sid_detectRegion', 'sid_frequencyOf']],
  reuTransfer: ['reu-transfer-probe.8bs', ['reu_stash', 'reu_fetch', 'reu_swap', 'reu_verify', 'reu_fillReu']],
  text: ['text-probe.8bs', ['text_print', 'text_printNumber', 'text_fill', 'text_setReverse']],
  textTiming: ['text-timing-probe.8bs', ['text_print', 'text_printNumber', 'text_fill']],
};

for (const [name, [file, functions]] of Object.entries(PROBES)) {
  test(`the ${name} probe links clean for the C64, with its functions in the IR`, () => {
    const path = join(HERE, file);
    const { ir, diagnostics } = link(readFileSync(path, 'utf8'), path, { machine: 'c64', facts: stockFacts('c64') });
    assert.deepEqual(diagnostics, []);
    const names = ir.functions.map((f) => f.name);
    for (const fn of functions) assert.ok(names.includes(fn), fn);
    assert.equal(ir.nativeSources.length, 3, 'the package\'s raster.s, multiplex.s and text.s ride along (sections a program does not reach are dropped at link)');
  });
}

// The rasterline probe reaches this package through @8bitscript/raster, so
// its link resolves @8bitscript/* through this checkout rather than
// node_modules (packages/c64 has no node_modules of its own).
const CHECKOUT = join(ROOT, '..', '..');

test('the rasterline probe links clean for the C64, @8bitscript/raster resolving to this package\'s slot layer', () => {
  const path = join(HERE, 'rasterline-probe.8bs');
  const { ir, diagnostics } = link(readFileSync(path, 'utf8'), path, {
    machine: 'c64', facts: stockFacts('c64'), checkout: CHECKOUT,
  });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  assert.ok(names.some((name) => /raster_at/.test(name)), `the slot layer and the address list link: ${names.join(', ')}`);
  assert.ok(names.some((name) => /raster_enable/.test(name)), 'enable() delegates through');
  assert.equal(ir.nativeSources.length, 3, 'the package\'s raster.s, multiplex.s and text.s ride along');
});

// --- Under VICE ---------------------------------------------------------

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
function runCli(args, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: String(err) }); });
  });
}

async function shoot(scratch, name, probe, extra = []) {
  const shot = join(scratch, `${name}.png`);
  const { code, stdout, stderr } = await runCli(['run', 'c64', ...extra, '--screenshot', shot, `test/${probe}`]);
  assert.equal(code, 0, `8bs run c64 ${extra.join(' ')} --screenshot failed:\n${stdout}${stderr}`);
  return readFileSync(shot);
}

// VICE's palette, by which channel dominates.
const isRed = ([r, g, b]) => r > g + 40 && r > b + 40;
const isGreen = ([r, g, b]) => g > r + 30 && g > b + 30;
const isBlue = ([r, g, b]) => b > r + 40 && b > g + 40;
const isYellow = ([r, g, b]) => r > 200 && g > 200 && b < 200;
const isWhite = ([r, g, b]) => r > 200 && g > 200 && b > 200;
const isDark = ([r, g, b]) => r < 60 && g < 60 && b < 60;

test('under VICE, the raster list changes the border color at its lines, top to bottom', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    const png = await shoot(scratch, 'raster', 'raster-probe.8bs');
    // x64sc's NTSC screenshot is 384 x 247, the border column at x = 4, and
    // raster line L at about y = L - 20 in it (measured: the first text
    // row, lines 51-58, is at y 31). The bands: blue, red from line 100,
    // green from 150, yellow from 200, blue from 240.
    assert.ok(isBlue(pixelAt(png, 4, 30)), `line ~50: blue, got ${pixelAt(png, 4, 30)}`);
    assert.ok(isRed(pixelAt(png, 4, 105)), `line ~125: red, got ${pixelAt(png, 4, 105)}`);
    assert.ok(isGreen(pixelAt(png, 4, 155)), `line ~175: green, got ${pixelAt(png, 4, 155)}`);
    assert.ok(isYellow(pixelAt(png, 4, 205)), `line ~225: yellow, got ${pixelAt(png, 4, 205)}`);
    assert.ok(isBlue(pixelAt(png, 4, 235)), `line ~255: blue, got ${pixelAt(png, 4, 235)}`);
    // The background inside the picture: green when the IRQ vector was
    // $00FD with an rti there and the NMI vector non-zero before enable()
    // — which makes $FFFF, the VIC's idle byte in bank 3, zero.
    assert.ok(isGreen(pixelAt(png, 200, 60)), `the .init vectors: a green background, got ${pixelAt(png, 200, 60)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, the portable rasterline slots land on $D020/$D021/$D016, picture lines 50 raster lines down', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    const png = await shoot(scratch, 'rasterline', 'rasterline-probe.8bs', ['--checkout', CHECKOUT]);
    // Same geometry as the raster test: raster line L at about y = L - 20,
    // the border column at x = 4, the picture at x = 32 onward. Picture
    // line 0 is raster line 50, so the red border and green background
    // both start around y = 30.
    assert.ok(isRed(pixelAt(png, 4, 100)), `picture lines 0-149: a red border, got ${pixelAt(png, 4, 100)}`);
    assert.ok(isBlue(pixelAt(png, 4, 200)), `picture line 150 on: a blue border, got ${pixelAt(png, 4, 200)}`);
    assert.ok(isGreen(pixelAt(png, 200, 60)), `the playfield: green from picture line 0, got ${pixelAt(png, 200, 60)}`);
    // Yellow below picture line 180 proves the refusal: the probe adds
    // this split only after at(200, ...) came back false.
    assert.ok(isYellow(pixelAt(png, 200, 220)), `picture line 180 on: the refusal's yellow band, got ${pixelAt(png, 200, 220)}`);
    // The SCROLL_X band: picture lines 100-129 (y ≈ 130-159) carry
    // XSCROLL 7, and every row's columns 0-19 are white blocks, so each
    // scanline's white/green edge sits at picture pixel 160 plus that
    // line's shift — rows inside the band sit exactly 7 pixels right of
    // the straight rows above.
    const edgeAt = (y) => {
      for (let px = 155; px <= 172; px++) if (!isWhite(pixelAt(png, 32 + px, y))) return px;
      return 173;
    };
    const straight = edgeAt(60);
    assert.ok(straight < 165, `a straight row's edge near pixel 160, got ${straight}`);
    assert.equal(edgeAt(142), straight + 7, `inside the band the edge shifts 7 pixels right of ${straight}`);
    assert.equal(edgeAt(150), straight + 7, 'and the whole band moved, not one scanline');
    // 38 columns held INSIDE the band: the probe goes narrow before
    // building the list, so picture pixels 0-6 stay border there — a
    // $D016 byte that forced CSEL back to 40 columns would fill them
    // with the picture instead.
    assert.ok(isRed(pixelAt(png, 32 + 2, 142)), `narrow mode's left border inside the band, got ${pixelAt(png, 32 + 2, 142)}`);
    assert.ok(isRed(pixelAt(png, 32 + 2, 60)), `and outside it, got ${pixelAt(png, 32 + 2, 60)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// Geometry, measured on this VICE (3.10 under Homebrew, 2026-09): the NTSC
// capture is 384 x 247; raster line L is PNG row L - 28 (the picture,
// lines 51-250, is rows 23-222; the lower border 251-262 rows 223-234;
// the next frame's lines 0-11 rows 235-246); VIC sprite X is PNG column
// X + 8 (the picture's pixel 0, X 24, is column 32).
const ROW = (line) => line - 28;
const COL = (x) => x + 8;

test('under VICE, the YSCROLL gap draws the ghost byte, and it is 0: the idle lines are the background color', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    const png = await shoot(scratch, 'idle', 'idle-probe.8bs');
    // The gap: lines 51-54 (rows 23-26), idle, every cell across. With the
    // handler's page in $FFFF this showed `....#.#.`; with 0 it is blue.
    for (const line of [51, 52, 53, 54]) {
      for (let x = 24; x < 344; x += 1) {
        assert.ok(isBlue(pixelAt(png, COL(x), ROW(line))), `line ${line}, X ${x}: blue, got ${pixelAt(png, COL(x), ROW(line))}`);
      }
    }
    assert.ok(isWhite(pixelAt(png, COL(100), ROW(55))), 'the first row starts at line 55 with YSCROLL 7');
    assert.ok(isGreen(pixelAt(png, 4, ROW(60))), `the border is green above 100: idle.ghost() read 0, got ${pixelAt(png, 4, ROW(60))}`);
    assert.ok(isRed(pixelAt(png, 4, ROW(150))), 'and red from 100: the handler is live');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, border.top()/bottom() open the upper and lower border for sprites, with the idle pattern where the list sets it', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    const png = await shoot(scratch, 'border', 'border-probe.8bs');
    // The side border stays: red at x = 4 down the whole capture.
    for (const y of [5, 20, 100, 225, 240]) assert.ok(isRed(pixelAt(png, 4, y)), `x 4, row ${y}: the side border, got ${pixelAt(png, 4, y)}`);
    // The upper border, lines 28-45: open and transparent (blue), with
    // sprite 1 (X 200, Y 20: lines 21-41) white on it.
    assert.ok(isBlue(pixelAt(png, COL(100), ROW(35))), `line 35: the upper border is open and blue, got ${pixelAt(png, COL(100), ROW(35))}`);
    assert.ok(isWhite(pixelAt(png, COL(212), ROW(35))), `line 35: the top sprite, got ${pixelAt(png, COL(212), ROW(35))}`);
    assert.ok(isBlue(pixelAt(png, COL(212), ROW(45))), 'line 45: below the top sprite, blue');
    // Lines 46-50: the pattern byte went black at 45.
    for (const line of [46, 48, 50]) assert.ok(isDark(pixelAt(png, COL(100), ROW(line))), `line ${line}: black pattern, got ${pixelAt(png, COL(100), ROW(line))}`);
    // The picture: white from 51 to 250.
    assert.ok(isWhite(pixelAt(png, COL(100), ROW(51))), 'line 51: the first row');
    assert.ok(isWhite(pixelAt(png, COL(100), ROW(250))), 'line 250: the last row');
    // The lower border: 251-254 black (ECM on at 250, pattern black),
    // 255 on transparent, sprite 0 (X 100, Y 252: lines 253-273) white.
    for (const line of [251, 252, 254]) assert.ok(isDark(pixelAt(png, COL(200), ROW(line))), `line ${line}: black pattern, got ${pixelAt(png, COL(200), ROW(line))}`);
    for (const line of [255, 258, 262]) assert.ok(isBlue(pixelAt(png, COL(200), ROW(line))), `line ${line}: open and blue, got ${pixelAt(png, COL(200), ROW(line))}`);
    for (const line of [254, 258, 262]) assert.ok(isWhite(pixelAt(png, COL(112), ROW(line))), `line ${line}: the bottom sprite, got ${pixelAt(png, COL(112), ROW(line))}`);
    // The sprite runs on into the next frame's top lines (NTSC: 263 lines):
    // rows 235-245 are lines 0-10 of the next frame, and it ends at 273.
    assert.ok(isWhite(pixelAt(png, COL(112), 240)), 'the bottom sprite continues across the frame wrap');
    assert.ok(isBlue(pixelAt(png, COL(112), 246)), 'and ends at line 273 (row 245)');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, the multiplexer draws twenty sprites from eight, rebuilt and committed every frame', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    // 600 frames: ~210 go to the autostart, the probe's loop takes
    // several frames each (its text.print is slow), and the drift stops
    // after 32 iterations — seen settled by 450, with margin here.
    const png = await shoot(scratch, 'multiplex', 'multiplex-probe.8bs', ['--frames', '600']);
    // VICE's palette for the rows' colors: yellow (255,248,141), cyan
    // (138,230,203), light green (198,255,186); white is white.
    const isYellow2 = ([r, g, b]) => r > 240 && g > 240 && b < 180;
    const isCyanish = ([r, g, b]) => r < 170 && g > 200 && b > 180;
    const isLightGreen = ([r, g, b]) => r > 170 && r < 230 && g > 240 && b > 160 && b < 210;
    const rows = [
      [60, isWhite, 'white'], [100, isYellow2, 'yellow'], [140, isCyanish, 'cyan'], [180, isLightGreen, 'light green'],
    ];
    for (const [y, is, name] of rows) {
      for (let c = 0; c < 5; c++) {
        const x = 40 + c * 60 + 32; // after the 32-pixel drift
        const px = pixelAt(png, COL(x + 12), ROW(y + 11)); // the block's center: lines y+1..y+21
        assert.ok(is(px), `row Y ${y}, column ${c} (X ${x}): ${name}, got ${px}`);
        assert.ok(isBlue(pixelAt(png, COL(x + 30), ROW(y + 11))), `and blue right of it (X ${x + 30})`);
      }
      // The block's vertical extent: y+1 .. y+21.
      assert.ok(isBlue(pixelAt(png, COL(40 + 32 + 12), ROW(y))), `line ${y}: above the block`);
      assert.ok(is(pixelAt(png, COL(40 + 32 + 12), ROW(y + 1))), `line ${y + 1}: the block's first row`);
      assert.ok(is(pixelAt(png, COL(40 + 32 + 12), ROW(y + 21))), `line ${y + 21}: its last`);
      assert.ok(isBlue(pixelAt(png, COL(40 + 32 + 12), ROW(y + 22))), `line ${y + 22}: below it`);
    }
    // The hidden one (X 160, Y 100): its spot is playfield.
    assert.ok(isBlue(pixelAt(png, COL(160 + 12), ROW(111))), 'the hidden sprite is not drawn');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, the wobble band shifts scanlines by different XSCROLL values inside its $D021 splits', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    // The probe switches its below-band split from blue to green only
    // after 60 waitFrame() returns, so give the program comfortably more
    // than 60 frames past autostart (~500 frames is ~8.5M cycles).
    const png = await shoot(scratch, 'wobble', 'wobble-probe.8bs', ['--frames', '500']);
    // The probe fills columns 0-19 with white blocks, so each scanline's
    // white/background edge sits at picture pixel 160 plus that line's
    // XSCROLL. Its band (raster lines 100-147, 24 $D016 entries at one
    // per two scanlines, red $D021 behind it) lands at y ≈ 75-122 in the
    // capture — this probe's picture runs about 5 lines above the
    // y = L - 20 estimate the raster test uses — so the rows sampled
    // here stay well inside it.
    const at = (px, y) => pixelAt(png, 32 + px, y);
    const edgeAt = (y) => {
      for (let px = 158; px <= 170; px++) if (!isWhite(at(px, y))) return px;
      return 171;
    };
    const edges = new Set();
    for (let y = 80; y <= 116; y++) {
      assert.ok(isWhite(at(150, y)), `y ${y}: white blocks at any shift, got ${at(150, y)}`);
      assert.ok(isRed(at(200, y)), `y ${y}: the band's red background, got ${at(200, y)}`);
      edges.add(edgeAt(y));
    }
    assert.ok(edges.size >= 2, `scanlines inside the band sit at different offsets: edges at ${[...edges].join(', ')}`);
    // A row inside the band differs from a row outside it: the band's
    // background is red against black above the first split, and its
    // widest shift beats the straight rows' edge.
    assert.ok(isDark(at(200, 40)), `above the splits: black, got ${at(200, 40)}`);
    assert.ok(isWhite(at(150, 140)), `blocks outside the band too, got ${at(150, 140)}`);
    assert.ok(Math.max(...edges) > edgeAt(40), `a band row shifted past the straight rows' edge at ${edgeAt(40)}`);
    // The frame-loop witness: the below-band split is BUILT blue, and only
    // the loop — 60 waitFrame() returns after raster.enable()'s cli, then
    // one raster.setValue — turns it green. Green here proves waitFrame()
    // kept returning with the raster IRQ still firing in the captured
    // frame: a hung waitFrame leaves this pixel blue, and a dead handler
    // leaves no splits at all (the red/black asserts above would fail).
    assert.ok(isGreen(at(200, 140)), `below the band, green only after 60 live waitFrame() frames, got ${at(200, 140)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, bitmap mode draws a plotted rectangle on colored cells and a sprite from a block under the I/O area', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    // 4800 plotted pixels are read-modify-writes over 16-bit offsets: the
    // default capture window (5M cycles, most of it autostart) catches the
    // rectangle a quarter drawn, so give the program ~15M cycles.
    const png = await shoot(scratch, 'bitmap', 'bitmap-probe.8bs', ['--frames', '900']);
    // The picture's pixel (px, py) is at (32 + px, 31 + py) in the
    // screenshot; a sprite at VIC (X, Y) has its top-left at picture
    // (X - 24, Y - 50).
    const at = (px, py) => pixelAt(png, 32 + px, 31 + py);
    assert.ok(isWhite(at(80, 70)), `inside the rectangle: white, got ${at(80, 70)}`);
    assert.ok(isBlue(at(200, 70)), `outside it: blue cells, got ${at(200, 70)}`);
    assert.ok(isYellow(at(250 - 24 + 12, 180 - 50 + 10)), `the sprite: yellow, got ${at(238, 140)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, detectRegion says NTSC under -model ntsc and PAL under -model c64', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    const ntsc = await shoot(scratch, 'ntsc', 'region-probe.8bs');
    assert.ok(isYellow(pixelAt(ntsc, 4, 4)), `NTSC: a yellow border, got ${pixelAt(ntsc, 4, 4)}`);
    const pal = await shoot(scratch, 'pal', 'region-probe.8bs', ['--pal']);
    assert.ok(isGreen(pixelAt(pal, 4, 4)), `PAL: a green border, got ${pixelAt(pal, 4, 4)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, hello-world holds Hello World on a black screen, not the boot READY', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-hello-'));
  try {
    const shot = join(scratch, 'hello.png');
    const example = join(ROOT, '..', 'examples', 'hello-world', 'src', 'hello-world.8bs');
    const { code, stdout, stderr } = await runCli(['run', 'c64', '--checkout', CHECKOUT, '--screenshot', shot, example]);
    assert.equal(code, 0, `8bs run c64 hello-world --screenshot failed:\n${stdout}${stderr}`);
    const png = readFileSync(shot);
    // Boot READY. is a light-blue border and dark-blue playfield. blank()
    // paints both black, and print() writes white glyphs at cell 0.
    assert.ok(isDark(pixelAt(png, 4, 30)), `black border, not boot light-blue: ${pixelAt(png, 4, 30)}`);
    assert.ok(isDark(pixelAt(png, 200, 80)), `black playfield, not boot dark-blue: ${pixelAt(png, 200, 80)}`);
    // Measured on the capture: the greeting's first glyph is white at
    // PNG (33, 23). Boot READY. has no white there — it is light-blue
    // on dark-blue, and those asserts above would already have failed.
    assert.ok(isWhite(pixelAt(png, 33, 23)), `H of Hello World, got ${pixelAt(png, 33, 23)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, the native text routines write what text.8bs promises: codes, colors, reverse, every number width, a fill across a page', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-text-'));
  try {
    const png = await shoot(scratch, 'text', 'text-probe.8bs');
    // The probe reads its own writes back and paints the border green
    // when all 41 checks held, red at the first that did not (its number
    // is on row 20 — read the screenshot when this fails).
    assert.ok(isGreen(pixelAt(png, 4, 30)), `a green border: every check held, got ${pixelAt(png, 4, 30)}`);
    // And the picture itself: picture pixel (0, 0) is PNG (32, 23) (the
    // hello-world test above), a cell is 8 x 8, and the ROM's '*' has its
    // middle row lit at pixels 3-5 — so pixel (4, 3) of a cell. The
    // fill's green stars run from cell 200 (row 5, column 0) to 499 (row
    // 12, column 19), and cell 500 beside it is still the blue playfield.
    const star = (row, column) => pixelAt(png, 32 + column * 8 + 4, 23 + row * 8 + 3);
    assert.ok(isGreen(star(5, 0)), `a star at cell 200, got ${star(5, 0)}`);
    assert.ok(isGreen(star(12, 19)), `a star at cell 499, got ${star(12, 19)}`);
    assert.ok(isBlue(star(12, 20)), `cell 500 untouched, got ${star(12, 20)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, REU transfers round-trip the screen through a 512 KiB unit, and a stock C64 tries none', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    const reu = await shoot(scratch, 'reu512', 'reu-transfer-probe.8bs', ['--hardware', 'ram=reu512']);
    assert.ok(isGreen(pixelAt(reu, 4, 4)), `512 KiB: a green border, got ${pixelAt(reu, 4, 4)}`);
    const none = await shoot(scratch, 'none', 'reu-transfer-probe.8bs');
    assert.ok(isRed(pixelAt(none, 4, 4)), `no REU: a red border, got ${pixelAt(none, 4, 4)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
