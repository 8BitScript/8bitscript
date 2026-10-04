// `8bs conform` — the comparison logic, over synthetic captures.
//
// The emulator-backed run (does the real VICE look like the wasm page?) needs
// the emulators and lives in packages/web/test/conform.test.mjs, which CI
// skips with the machine packages. Everything that decides what a difference
// IS — finding the picture, reading cells, telling a wrong glyph from a wrong
// colour, the arguments, the exit codes — is pure, and is tested here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { encodePNG } from '../src/png.mjs';
import { decodePNG } from '../src/png-decode.mjs';
import {
  CELL, GRIDS, CONFORM_MACHINES, backgroundOf, inkBounds, locatePicture, readCells, compareCells,
  centredPicture, compareCaptures, renderDiff, parseConformArgs, conformCommand, captureOnce, CONFORM_PROJECT,
} from '../src/conform.mjs';

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

const SQUARE = new Uint8Array(64).fill(1);
const STRIPES = Uint8Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? 1 : 0));

/**
 * A capture of a `cols x rows` text grid: a border of `bx`/`by` pixels around
 * the picture, each source pixel `scale` wide, and `cells` drawn into it
 * ({ col, row, bits, color }). `corners: false` leaves the probe's solid
 * corner cells out, as a machine with no reverse video does.
 */
function capture({ cols, rows, bx = 24, by = 24, scale = 1, cells = [], corners = true, color = WHITE }) {
  const grid = [...cells];
  if (corners) {
    for (const [col, row] of [[0, 0], [cols - 1, 0], [0, rows - 1], [cols - 1, rows - 1]]) {
      grid.push({ col, row, bits: SQUARE, color });
    }
  }
  const width = cols * CELL * scale + bx * 2;
  const height = rows * CELL * scale + by * 2;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i + 3] = 255; }
  for (const cell of grid) {
    for (let j = 0; j < CELL; j += 1) {
      for (let i = 0; i < CELL; i += 1) {
        if (!cell.bits[j * CELL + i]) continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = bx + (cell.col * CELL + i) * scale + dx;
            const y = by + (cell.row * CELL + j) * scale + dy;
            const o = (y * width + x) * 4;
            rgba[o] = cell.color[0]; rgba[o + 1] = cell.color[1]; rgba[o + 2] = cell.color[2];
          }
        }
      }
    }
  }
  return encodePNG(width, height, rgba);
}

const GRID = { cols: 6, rows: 4 };
const glyph = (col, row, bits = STRIPES, color = WHITE) => ({ col, row, bits, color });

// ---- the decoder ---------------------------------------------------------

test('decodePNG reads back what encodePNG wrote', () => {
  const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 9, 8, 7, 6]);
  const { width, height, rgba: back } = decodePNG(encodePNG(2, 2, rgba));
  assert.equal(width, 2);
  assert.equal(height, 2);
  assert.deepEqual([...back], [...rgba]);
});

/** A PNG built by hand, so the decoder meets filter types and colour types the encoder never writes. */
function handmade({ width, height, colorType, rows, palette, filters }) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  let previous = new Uint8Array(stride);
  rows.forEach((row, y) => {
    const filter = filters[y];
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      }
      raw[y * (stride + 1) + 1 + i] = (row[i] - predictor) & 0xff;
    }
    previous = row;
  });
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, data, Buffer.alloc(4)]); // the CRC is not checked by the decoder
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(palette ? [chunk('PLTE', Buffer.from(palette))] : []),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('decodePNG undoes every filter type', () => {
  const rows = [[10, 20, 30, 40, 50, 60], [70, 80, 90, 100, 110, 120], [5, 250, 17, 99, 3, 200], [1, 2, 3, 4, 5, 6], [200, 100, 50, 25, 12, 6]];
  const buf = handmade({ width: 2, height: 5, colorType: 2, rows, filters: [0, 1, 2, 3, 4] });
  const { rgba } = decodePNG(buf);
  const rgb = [];
  for (let i = 0; i < rgba.length; i += 4) rgb.push(rgba[i], rgba[i + 1], rgba[i + 2]);
  assert.deepEqual(rgb, rows.flat());
});

test('decodePNG reads palette and grey images', () => {
  const palette = handmade({ width: 2, height: 1, colorType: 3, rows: [[1, 0]], palette: [10, 20, 30, 200, 210, 220], filters: [0] });
  assert.deepEqual([...decodePNG(palette).rgba], [200, 210, 220, 255, 10, 20, 30, 255]);
  const grey = handmade({ width: 2, height: 1, colorType: 0, rows: [[7, 90]], filters: [0] });
  assert.deepEqual([...decodePNG(grey).rgba], [7, 7, 7, 255, 90, 90, 90, 255]);
  const greyAlpha = handmade({ width: 1, height: 1, colorType: 4, rows: [[33, 44]], filters: [0] });
  assert.deepEqual([...decodePNG(greyAlpha).rgba], [33, 33, 33, 44]);
});

test('decodePNG refuses what it cannot read rather than guessing', () => {
  assert.throws(() => decodePNG(Buffer.from('not a png at all')), /not a PNG/);
  const sixteen = handmade({ width: 1, height: 1, colorType: 2, rows: [[1, 2, 3]], filters: [0] });
  sixteen[24] = 16; // the IHDR bit depth
  assert.throws(() => decodePNG(sixteen), /bit depth 16/);
  const badFilter = handmade({ width: 1, height: 1, colorType: 2, rows: [[1, 2, 3]], filters: [9] });
  assert.throws(() => decodePNG(badFilter), /filter type 9/);
  const noPalette = handmade({ width: 1, height: 1, colorType: 3, rows: [[0]], filters: [0] });
  assert.throws(() => decodePNG(noPalette), /PLTE/);
});

// ---- finding the picture -------------------------------------------------

test('the picture is the bounding box of the corner cells, at any border and scale', () => {
  for (const { bx, by, scale } of [{ bx: 24, by: 24, scale: 1 }, { bx: 40, by: 11, scale: 1 }, { bx: 30, by: 17, scale: 2 }]) {
    const img = decodePNG(capture({ ...GRID, bx, by, scale }));
    const rect = locatePicture(img, GRID);
    assert.equal(rect.x0, bx);
    assert.equal(rect.y0, by);
    assert.equal(rect.sx, scale);
    assert.equal(rect.sy, scale);
    assert.equal(rect.w, GRID.cols * CELL * scale);
  }
});

test('a non-integer scale is found too (a 520-pixel-wide VIC-20 capture is not a multiple of its 176)', () => {
  const img = decodePNG(capture({ ...GRID, scale: 3 }));
  assert.equal(locatePicture(img, { cols: 6, rows: 4 }).sx, 3);
  const wide = decodePNG(capture({ cols: 22, rows: 23, bx: 8, by: 8 }));
  assert.equal(locatePicture(wide, GRIDS.vic20).w, 176);
});

test('locatePicture says what is wrong when it cannot find the picture', () => {
  const blank = decodePNG(encodePNG(20, 20, new Uint8Array(20 * 20 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 0))));
  assert.throws(() => locatePicture(blank, GRID), /one colour: nothing was drawn/);
  const lopsided = decodePNG(capture({ ...GRID, cells: [glyph(30, 0)], corners: false }));
  assert.throws(() => locatePicture(lopsided, GRID), /not 6x4 cells at any sensible scale/);
});

test('the background is the commonest colour and ink bounds exclude it', () => {
  const img = decodePNG(capture({ ...GRID }));
  assert.deepEqual(backgroundOf(img), BLACK);
  const box = inkBounds(img, BLACK);
  assert.equal(box.x1 - box.x0 + 1, GRID.cols * CELL);
  assert.equal(inkBounds(decodePNG(encodePNG(1, 1, Uint8Array.from([0, 0, 0, 255]))), BLACK), null);
});

test('the centred picture is where the wasm page puts it', () => {
  const img = decodePNG(capture({ ...GRID, bx: 24, by: 24 }));
  assert.deepEqual(centredPicture(img, GRID), { x0: 24, y0: 24, sx: 1, sy: 1, w: 48, h: 32 });
});

// ---- comparing cells -----------------------------------------------------

test('two identical captures have no difference at all', () => {
  const png = capture({ ...GRID, cells: [glyph(2, 1), glyph(3, 1, SQUARE, [255, 0, 0])] });
  const result = compareCaptures(png, png, GRID);
  assert.equal(result.total, 24);
  assert.equal(result.structural.length, 0);
  assert.equal(result.colour.length, 0);
});

test('captures of different sizes and borders compare by cell, not by pixel', () => {
  const native = capture({ ...GRID, bx: 32, by: 9, scale: 2, cells: [glyph(2, 1)] });
  const wasm = capture({ ...GRID, bx: 24, by: 24, scale: 1, cells: [glyph(2, 1)] });
  const result = compareCaptures(native, wasm, GRID);
  assert.equal(result.structural.length, 0);
  assert.equal(result.native.picture.sx, 2);
  assert.equal(result.wasm.picture.sx, 1);
});

test('a wrong glyph is a structural difference, reported at its cell with the pixel count', () => {
  const native = capture({ ...GRID, cells: [glyph(2, 1)] });
  const flipped = Uint8Array.from(STRIPES); flipped[0] = 0; flipped[9] = 1;
  const wasm = capture({ ...GRID, cells: [glyph(2, 1, flipped)] });
  const result = compareCaptures(native, wasm, GRID);
  assert.deepEqual(result.structural.map((s) => [s.col, s.row, s.bits]), [[2, 1, 2]]);
  assert.equal(result.colour.length, 0);
});

test('the structure tolerance lets a cell off by a few pixels pass', () => {
  const native = capture({ ...GRID, cells: [glyph(2, 1)] });
  const flipped = Uint8Array.from(STRIPES); flipped[0] = 0;
  const wasm = capture({ ...GRID, cells: [glyph(2, 1, flipped)] });
  assert.equal(compareCaptures(native, wasm, GRID).structural.length, 1);
  assert.equal(compareCaptures(native, wasm, GRID, { structuralTolerance: 1 }).structural.length, 0);
});

test('the same glyph in another colour is a colour difference, with each side palette named', () => {
  const native = capture({ ...GRID, cells: [glyph(2, 1, STRIPES, [213, 213, 255])] });
  const wasm = capture({ ...GRID, cells: [glyph(2, 1, STRIPES, [80, 255, 80])] });
  const result = compareCaptures(native, wasm, GRID);
  assert.equal(result.structural.length, 0);
  assert.deepEqual(result.colour.map((c) => [c.col, c.row]), [[2, 1]]);
  assert.ok(result.palette.a.includes('213,213,255'));
  assert.ok(result.palette.b.includes('80,255,80'));
  assert.equal(compareCaptures(native, wasm, GRID, { colourTolerance: 200 }).colour.length, 0);
});

test('a machine with no corner cells is read where the page puts the picture, and they show as differences', () => {
  const native = capture({ ...GRID, cells: [glyph(2, 1)] });
  const wasm = capture({ ...GRID, cells: [glyph(2, 1)], corners: false });
  const result = compareCaptures(native, wasm, GRID);
  assert.match(result.wasm.located, /centred in the page/);
  assert.deepEqual(result.structural.map((s) => [s.col, s.row, s.bits]).sort(),
    [[0, 0, 64], [0, 3, 64], [5, 0, 64], [5, 3, 64]]);
  assert.equal(compareCaptures(native, native, GRID).wasm.located, 'corner cells');
});

test('an unlocatable native capture is an error, not a guess', () => {
  const wasm = capture({ ...GRID });
  const native = capture({ ...GRID, corners: false });
  assert.throws(() => compareCaptures(native, wasm, GRID), /one colour|sensible scale/);
});

test('compareCells counts per cell and ignores a cell that is blank on both sides', () => {
  const img = decodePNG(capture({ ...GRID }));
  const cells = readCells(img, locatePicture(img, GRID), GRID);
  assert.equal(cells.length, 24);
  assert.equal(cells.filter((c) => c.ink).length, 4);
  assert.deepEqual(compareCells(cells, cells), { total: 24, structural: [], colour: [], palette: { a: ['255,255,255'], b: ['255,255,255'] } });
});

test('the diff image is three panels, red where the structure differs and amber where only the colour does', () => {
  const native = capture({ ...GRID, cells: [glyph(1, 1), glyph(3, 2, STRIPES, [255, 0, 0])] });
  const flipped = Uint8Array.from(STRIPES); flipped[0] = 0;
  const wasm = capture({ ...GRID, cells: [glyph(1, 1, flipped), glyph(3, 2, STRIPES, [0, 0, 255])] });
  const result = compareCaptures(native, wasm, GRID);
  const diff = renderDiff(readCells(decodePNG(native), result.native.picture, GRID), readCells(decodePNG(wasm), result.wasm.picture, GRID), result, GRID);
  assert.equal(diff.width, GRID.cols * CELL * 2 * 3 + 16);
  assert.equal(diff.height, GRID.rows * CELL * 2);
  const at = (x, y) => [...diff.rgba.slice((y * diff.width + x) * 4, (y * diff.width + x) * 4 + 3)];
  const third = GRID.cols * CELL * 2 + 8;
  assert.deepEqual(at(2 * third + (1 * CELL + 1) * 2, (1 * CELL + 1) * 2), [255, 64, 64]);
  assert.deepEqual(at(2 * third + (3 * CELL + 1) * 2, (2 * CELL + 1) * 2), [255, 176, 32]);
  assert.equal(decodePNG(encodePNG(diff.width, diff.height, diff.rgba)).width, diff.width);
});

// ---- the command ---------------------------------------------------------

test('the arguments: machines, options, and the mistakes people make', () => {
  const defaults = parseConformArgs([]);
  assert.deepEqual(defaults.machines, CONFORM_MACHINES);
  assert.equal(defaults.program, 'grid');
  assert.equal(defaults.frames, 300);
  assert.equal(defaults.strictColour, false);
  assert.equal(defaults.project, CONFORM_PROJECT);
  const picked = parseConformArgs(['c64', 'pet', '--program', 'bands', '--frames', '120', '--out', 'x', '--strict-colour',
    '--colour-tolerance', '10', '--structure-tolerance', '3']);
  assert.deepEqual(picked.machines, ['c64', 'pet']);
  assert.deepEqual([picked.program, picked.frames, picked.out, picked.strictColour, picked.colourTolerance, picked.structuralTolerance],
    ['bands', 120, 'x', true, 10, 3]);
  assert.equal(parseConformArgs(['-h']).help, true);
  assert.match(parseConformArgs(['web']).error, /not a machine with both a native emulator and a wasm build/);
  assert.match(parseConformArgs(['--nope']).error, /unknown option --nope/);
  assert.match(parseConformArgs(['--frames']).error, /takes a value/);
  assert.match(parseConformArgs(['--frames', 'many']).error, /whole number/);
  assert.equal(parseConformArgs(['--project', '.']).project, process.cwd());
});

test('the grids are the release hardware, and every conform machine has one', () => {
  for (const machine of CONFORM_MACHINES) assert.ok(GRIDS[machine], machine);
  assert.deepEqual(GRIDS.vic20, { cols: 22, rows: 23 });
});

/** A fake `capture` that writes the synthetic PNGs the test wants for each side. */
function fakeCapture(sides) {
  const calls = [];
  const fn = (machine, options, wasm, file) => {
    calls.push({ machine, wasm, file });
    const side = sides[machine]?.[wasm ? 'wasm' : 'native'];
    if (side instanceof Error) return { ok: false, error: side.message };
    writeFileSync(file, side);
    return { ok: true };
  };
  fn.calls = calls;
  return fn;
}

/** Run the command over fake captures; what it wrote is read before the directory goes. */
async function runCommand(argv, sides) {
  const dir = mkdtempSync(join(tmpdir(), 'conform-'));
  let text = '';
  const fake = fakeCapture(sides);
  try {
    const status = await conformCommand([...argv, '--out', dir, '--project', dir], { capture: fake, write: (s) => { text += s; } });
    const reportFile = join(dir, 'grid.json');
    return {
      status,
      text,
      calls: fake.calls,
      files: (name) => existsSync(join(dir, name)),
      report: existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null,
      wroteDiff: existsSync(join(dir, 'grid-c64.diff.png')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SIXTY = { cols: 40, rows: 25 };
const same = () => capture({ ...SIXTY, cells: [glyph(5, 5)] });

test('conform exits 0 when the machine matches, and writes the captures, the diff and a report', async () => {
  const run = await runCommand(['c64'], { c64: { native: same(), wasm: same() } });
  assert.equal(run.status, 0);
  assert.match(run.text, /c64\s+match\s+1000 cells: 0 structure, 0 colour/);
  assert.deepEqual(run.calls.map((c) => c.wasm), [true, false]);
  assert.ok(run.wroteDiff, 'the diff image is written even when nothing differs');
  assert.equal(run.report.machines.c64.ok, true);
  assert.equal(run.report.machines.c64.cells, 1000);
});

test('conform exits 1 on a structural difference and names the cells', async () => {
  const wasm = capture({ ...SIXTY, cells: [glyph(5, 5, SQUARE)] });
  const run = await runCommand(['c64'], { c64: { native: same(), wasm } });
  assert.equal(run.status, 1);
  assert.match(run.text, /c64\s+DIFFER/);
  assert.match(run.text, /cell 5,5: \d+ of 64 pixels differ/);
});

test('a colour difference warns, and fails only under --strict-colour', async () => {
  const native = capture({ ...SIXTY, cells: [glyph(5, 5, STRIPES, [213, 213, 255])] });
  const wasm = capture({ ...SIXTY, cells: [glyph(5, 5, STRIPES, [80, 255, 80])] });
  const warn = await runCommand(['pet'], { pet: { native, wasm } });
  assert.equal(warn.status, 0);
  assert.match(warn.text, /pet\s+colours/);
  assert.match(warn.text, /ink colours\s+native: .*213,213,255/s);
  const strict = await runCommand(['pet', '--strict-colour'], { pet: { native, wasm } });
  assert.equal(strict.status, 1);
});

test('a failed build or capture on either side is a failure with its reason, and the other machines still run', async () => {
  const run = await runCommand(['pet', 'c64'], {
    pet: { native: same(), wasm: new Error("'sprites_update': 'asm' blocks are never lowered") },
    c64: { native: same(), wasm: same() },
  });
  assert.equal(run.status, 1);
  assert.match(run.text, /pet\s+FAIL\s+the wasm build failed: 'sprites_update'/);
  assert.match(run.text, /c64\s+match/);
  const nativeDown = await runCommand(['c64'], { c64: { native: new Error('x64sc is not installed'), wasm: same() } });
  assert.match(nativeDown.text, /the native capture failed: x64sc is not installed/);
});

test('an unlocatable capture is reported as that machine failing', async () => {
  const run = await runCommand(['c64'], { c64: { native: capture({ ...SIXTY, corners: false }), wasm: same() } });
  assert.equal(run.status, 1);
  assert.match(run.text, /c64\s+FAIL\s+.*(one colour|sensible scale)/);
});

test('bad arguments exit 2 and print the usage; --help exits 0', async () => {
  let text = '';
  assert.equal(await conformCommand(['--nope'], { write: (s) => { text += s; } }), 2);
  assert.equal(await conformCommand(['--help'], { write: (s) => { text += s; } }), 0);
  assert.match(text, /Usage: 8bs conform/);
});

test('8bs conform --help prints its own block and exits before building anything', () => {
  const bin = join(import.meta.dirname, '..', 'bin', '8bs.mjs');
  const r = spawnSync(process.execPath, [bin, 'conform', '--help'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: 8bs conform/);
  assert.match(r.stdout, /Does the wasm build of a machine look like/);
  assert.doesNotMatch(r.stdout, /build --target/);
});

test('the real capture runs this CLI, and says why when it cannot make a picture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conform-capture-'));
  try {
    const options = { program: 'grid', frames: 5, project: dir };
    const file = join(dir, 'out.png');
    for (const wasm of [true, false]) {
      const result = captureOnce('pet', options, wasm, file);
      assert.equal(result.ok, false, 'an empty directory has no probe to build');
      assert.ok(result.error.length > 0 && result.error.length <= 300, result.error);
      assert.equal(existsSync(file), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the probe project ships with the package and builds for every conform machine', () => {
  assert.ok(existsSync(join(CONFORM_PROJECT, '8bitscript.config.8bs')));
  assert.ok(existsSync(join(CONFORM_PROJECT, 'src', 'grid.8bs')));
  const pkg = JSON.parse(readFileSync(join(CONFORM_PROJECT, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('conform'), 'package.json "files" must include conform/ or the probes are not published');
});
