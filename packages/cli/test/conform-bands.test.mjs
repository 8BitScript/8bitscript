// The raster-band comparison behind `8bs conform bands`, on synthetic captures:
// a solid white picture in a border whose colour changes at named picture
// lines, drawn at the scale and position a real emulator would put it, so the
// logic is tested in CI where no emulator is installed. The machine packages'
// own conform.bands tests run it against xvic and x64sc.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BAND_MACHINES, BAND_STARTS, compareBandCaptures, compareBands, locateBandsPicture, measureBands } from '../src/conform-bands.mjs';
import { conformCommand, parseConformArgs } from '../src/conform.mjs';
import { encodePNG } from '../src/png.mjs';

const GRID = { cols: 22, rows: 23 };
const COLOURS = [[0, 0, 0], [200, 40, 40], [40, 160, 40], [40, 40, 200], [220, 200, 40], [170, 40, 170]];

/**
 * A capture: `width x height`, a black margin, the picture at (x0, y0) scaled sx by sy, a white
 * picture, and a border strip beside it whose colour for each picture line is `colourOf(line)`.
 */
function capture({ width = 300, height = 260, x0 = 60, y0 = 30, sx = 1, sy = 1, colourOf, strip = 20 }) {
  const rgba = new Uint8Array(width * height * 4);
  const put = (x, y, c) => { const o = (y * width + x) * 4; rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255; };
  const pictureW = GRID.cols * 8 * sx;
  const pictureH = GRID.rows * 8 * sy;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) put(x, y, [8, 8, 8]);
  for (let y = 0; y < pictureH; y += 1) {
    const line = Math.floor(y / sy);
    for (let x = 0; x < pictureW; x += 1) put(x0 + x, y0 + y, [255, 255, 255]);
    for (let x = x0 - strip; x < x0; x += 1) put(x, y0 + y, colourOf(line));
  }
  return { width, height, rgba };
}

/** The band colour at `line` when the bands start at `starts`. */
const bandsAt = (starts) => (line) => {
  let index = 0;
  starts.forEach((s, i) => { if (line >= s) index = i; });
  return COLOURS[index];
};

test('the picture is the solid rectangle through the centre, at any scale and position', () => {
  for (const shape of [{}, { sx: 2, sy: 1, x0: 40, y0: 12, width: 520, height: 234 }, { sx: 1, sy: 1, x0: 10, y0: 4 }]) {
    const img = capture({ colourOf: bandsAt(BAND_STARTS), ...shape });
    const rect = locateBandsPicture(img, GRID);
    assert.equal(rect.x0, shape.x0 ?? 60);
    assert.equal(rect.y0, shape.y0 ?? 30);
    assert.equal(rect.w, GRID.cols * 8 * (shape.sx ?? 1));
    assert.equal(rect.h, GRID.rows * 8 * (shape.sy ?? 1));
  }
});

test('a capture whose centre is not the bands probe says so, in a sentence', () => {
  // A capture that is one solid colour all over: its "picture" is the whole screen, which is no 22x23 grid at any sensible scale.
  const img = capture({ width: 2000, height: 1000, colourOf: bandsAt(BAND_STARTS) });
  img.rgba.fill(255);
  assert.throws(() => locateBandsPicture(img, GRID), /not the bands probe/);
});

test('measureBands finds the first line of every band, at scale 1 and at an emulator-like scale', () => {
  for (const shape of [{}, { sx: 2, sy: 1, x0: 40, y0: 12, width: 520, height: 234 }, { sx: 2, sy: 2, x0: 40, y0: 6, width: 520, height: 420 }]) {
    const { bands } = measureBands(capture({ colourOf: bandsAt(BAND_STARTS), ...shape }), GRID);
    assert.deepEqual(bands.map((b) => b.start), BAND_STARTS);
    assert.equal(bands[bands.length - 1].end, GRID.rows * 8 - 1, 'the last band runs to the last picture line');
  }
});

test('compareBands: equal starts match; a band one line off is within tolerance 2 and not within 0', () => {
  const a = BAND_STARTS.map((start, i) => ({ start, end: start, rgb: COLOURS[i] }));
  const exact = compareBands(a, a);
  assert.equal(exact.ok, true);
  assert.equal(exact.maxOffset, 0);
  assert.ok(exact.rows.every((r) => r.wasmExact));
  const late = a.map((b, i) => (i === 3 ? { ...b, start: b.start + 1 } : b));
  const near = compareBands(a, late);
  assert.equal(near.ok, true, 'one line late is inside the default tolerance of two');
  assert.equal(near.maxOffset, 1);
  assert.equal(compareBands(a, late, BAND_STARTS, 0).ok, false, 'and outside a tolerance of none');
  assert.equal(near.rows[3].wasmExact, false);
  assert.equal(near.rows[3].offset, 1);
});

test('compareBands: a missing band fails, a different colour only warns', () => {
  const a = BAND_STARTS.map((start, i) => ({ start, end: start, rgb: COLOURS[i] }));
  assert.equal(compareBands(a, a.slice(0, 5)).ok, false, 'a band the wasm build never draws');
  assert.equal(compareBands(a, a.slice(0, 5)).count, false);
  const recoloured = a.map((b, i) => (i === 2 ? { ...b, rgb: [10, 250, 250] } : b));
  const warned = compareBands(a, recoloured);
  assert.equal(warned.ok, true, 'a palette difference is not a failure');
  assert.equal(warned.colourDiffs, 1);
  assert.equal(warned.rows[2].sameColour, false);
});

test('compareBandCaptures reads two PNGs: native one line late, wasm exact', () => {
  const nativeStarts = BAND_STARTS.map((s) => (s === 0 ? 0 : s + 1));
  const native = encodePNG(...pngArgs(capture({ colourOf: bandsAt(nativeStarts), sx: 2, x0: 40, y0: 12, width: 520, height: 234 })));
  const wasm = encodePNG(...pngArgs(capture({ colourOf: bandsAt(BAND_STARTS) })));
  const result = compareBandCaptures(native, wasm, GRID);
  assert.equal(result.ok, true);
  assert.equal(result.maxOffset, 1);
  assert.deepEqual(result.rows.map((r) => r.nativeOffset), [0, 1, 1, 1, 1, 1], 'the native side against the lines the program named');
  assert.ok(result.rows.every((r) => r.wasmExact), 'the wasm side is exact');
  assert.equal(compareBandCaptures(native, wasm, GRID, { tolerance: 0 }).ok, false);
});

const pngArgs = (img) => [img.width, img.height, img.rgba];

test('8bs conform bands: only machines with BORDER entries on both sides are accepted', () => {
  assert.deepEqual(BAND_MACHINES, ['vic20', 'c64']);
  const none = parseConformArgs(['--program', 'bands']);
  assert.deepEqual(none.machines, ['vic20', 'c64'], 'the default is the machines that can');
  assert.equal(parseConformArgs(['--program', 'bands', 'vic20']).bandTolerance, 2);
  assert.equal(parseConformArgs(['--program', 'bands', 'vic20', '--band-tolerance', '4']).bandTolerance, 4);
  assert.match(parseConformArgs(['--program', 'bands', 'pet']).error, /only vic20 and c64 build on both sides today \(not pet\)/);
  assert.match(parseConformArgs(['--band-tolerance', 'x']).error, /whole number/);
});

test('8bs conform bands runs the comparison on whatever the injected capture writes, and reports the lines', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const out = mkdtempSync(join(tmpdir(), 'conform-bands-'));
  try {
    const wasmPng = encodePNG(...pngArgs(capture({ colourOf: bandsAt(BAND_STARTS) })));
    const nativePng = encodePNG(...pngArgs(capture({ colourOf: bandsAt(BAND_STARTS.map((s) => (s === 0 ? 0 : s + 1))), sx: 2, x0: 40, y0: 12, width: 520, height: 234 })));
    let text = '';
    const status = await conformCommand(['vic20', '--program', 'bands', '--out', out], {
      capture: (machine, options, wasm, file) => { writeFileSync(file, wasm ? wasmPng : nativePng); return { ok: true }; },
      write: (s) => { text += s; },
    });
    assert.equal(status, 0);
    assert.match(text, /vic20\s+match\s+6 bands/);
    assert.match(text, /\+1/, 'the native side is reported one line after the named line');
    const report = JSON.parse(readFileSync(join(out, 'bands.json'), 'utf8'));
    assert.equal(report.machines.vic20.ok, true);
    assert.equal(report.machines.vic20.maxOffset, 1);
    // Beyond the tolerance it fails with status 1.
    const strict = await conformCommand(['vic20', '--program', 'bands', '--out', out, '--band-tolerance', '0'], {
      capture: (machine, options, wasm, file) => { writeFileSync(file, wasm ? wasmPng : nativePng); return { ok: true }; },
      write: () => {},
    });
    assert.equal(strict, 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
