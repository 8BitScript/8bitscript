// The high-resolution Modern host (machine=hifi-hires): a cell is a whole
// number of device pixels, the window decides how many fit, and the program's
// geometry twin, the build's agreement and the page's inlined rule all say
// the same numbers. Headless screenshots have no pixel ratio, so the table
// below is what pins the grid rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderLoader } from '../src/web-loader.mjs';
import {
  HIRES_MAX_CELLS, HIRES_MAX_COLUMNS, HIRES_MAX_ROWS, MIN_COLUMNS, MIN_ROWS, agreementFor, hiresGridFor, layoutFromHardware,
} from '../src/web-layout.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadLoader(options) {
  const self = {};
  runInNewContext(renderLoader(options), { self, console });
  return self.EightBitScript;
}

const CASES = [
  // [width, height, dpr, cols, rows, k]
  [1920, 1080, 1, 120, 67, 2], // a 1080p monitor: 16 CSS px text
  [1440, 800, 2, 90, 50, 4],   // a retina laptop: still 16 CSS px text
  [1280, 720, 1.5, 80, 45, 3], // a fractional ratio gets whole device pixels
  [390, 844, 3, 24, 52, 6],    // a phone
  [3840, 2160, 1, 160, 90, 3], // 4K at a ratio of 1 would need 240x135 cells: k goes up instead
  [300, 200, 1, 37, 25, 1],    // too small for 24 columns at k=2: k comes down
];

test('the hires grid is the cells that fit at 16 CSS px text, with whole device pixels per font pixel', () => {
  for (const [width, height, dpr, cols, rows, k] of CASES) {
    assert.deepEqual(hiresGridFor({ width, height, dpr }), { cols, rows, k }, `${width}x${height} at ${dpr}`);
  }
});

test('it never hands out more than the map holds or less than a layout can use', () => {
  for (const width of [200, 640, 1000, 2560, 5000]) {
    for (const height of [150, 480, 900, 1440, 3000]) {
      for (const dpr of [1, 1.25, 2, 3]) {
        const { cols, rows, k } = hiresGridFor({ width, height, dpr });
        assert.ok(Number.isInteger(k) && k >= 1);
        assert.ok(cols <= HIRES_MAX_COLUMNS && rows <= HIRES_MAX_ROWS && cols * rows <= HIRES_MAX_CELLS);
        assert.ok(cols >= MIN_COLUMNS && rows >= MIN_ROWS);
      }
    }
  }
});

test('an unmeasured box gets the X16 grid, and hifi keeps its own rule', () => {
  assert.deepEqual(hiresGridFor({}), { cols: 76, rows: 56, k: 2 });
  const { gridFor } = loadLoader({ frameRate: 60 });
  assert.deepEqual({ ...gridFor({ width: 1920, height: 1080 }) }, { cols: 48, rows: 27 });
});

test("the loader's hiresGridFor agrees with web-layout.mjs", () => {
  const { hiresGridFor: inLoader } = loadLoader({ frameRate: 60 });
  for (const [width, height, dpr] of [...CASES, [0, 0, 1], [1024, 768, 2], [2000, 100, 1]]) {
    assert.deepEqual({ ...inLoader({ width, height, dpr }) }, hiresGridFor({ width, height, dpr }), `${width}x${height} at ${dpr}`);
  }
});

test('the hires agreement is mapped for 160x100 and says so to the page', () => {
  const layout = layoutFromHardware({ facts: { 'video.columns': 76, 'video.rows': 56 }, options: { machine: 'hifi-hires' } });
  assert.equal(layout.hires, true);
  assert.equal(layout.resizable, true);
  assert.equal(layout.maxCols, 160);
  assert.equal(layout.maxRows, 100);
  assert.equal(layout.colorBase - layout.charBase, HIRES_MAX_CELLS);
  assert.equal(layoutFromHardware({ options: { machine: 'hifi' } }).hires, false);
  assert.equal(loadLoader({ frameRate: 60, layout }).layout.hires, true);
});

test("the program's geometry twin has the numbers agreementFor() gives the hires host", () => {
  const layout = agreementFor({ cols: 76, rows: 56, resizable: true, hires: true, userGlyphs: true, audio: true, pointer: true });
  const twin = readFileSync(join(HERE, '..', '..', 'web', 'src', 'geometry.web.hifi-hires.8bs'), 'utf8');
  const constant = (name) => Number(twin.match(new RegExp(`const ${name}: \\w+ = (\\d+);`))?.[1]);
  assert.equal(constant('MAX_COLUMNS'), layout.maxCols);
  assert.equal(constant('MAX_ROWS'), layout.maxRows);
  assert.equal(constant('MAX_CELLS'), HIRES_MAX_CELLS);
  assert.equal(constant('COLUMNS'), 76);
  assert.equal(constant('ROWS'), 56);
  assert.equal(constant('CELL_COUNT'), 76 * 56);
  assert.equal(constant('COLOR_BASE'), layout.colorBase);
  assert.equal(constant('INPUT_OFFSET'), layout.inputOffset);
  assert.equal(constant('HOST_OFFSET'), layout.hostOffset);
  assert.equal(constant('RASTER_CONTROL_OFFSET'), layout.rasterControlOffset);
  assert.equal(constant('RASTER_COUNT_OFFSET'), layout.rasterCountOffset);
  assert.equal(constant('RASTER_BASE'), layout.rasterBase);
  assert.equal(constant('GLYPH_BASE'), layout.glyphBase);
  assert.equal(constant('AUDIO_BASE'), layout.audioBase);
  assert.equal(constant('POINTER_BASE'), layout.pointerOffset);
  assert.ok(layout.reservedEnd < 65536 - 16384, 'the program keeps at least 16K of the page');
});

test('the fluid host fits hires at exactly k device pixels per font pixel', () => {
  const source = renderLoader({ frameRate: 60 });
  assert.match(source, /if \(HIRES && hiresK > 0\) \{[^}]*scale = hiresK \/ dpr;/s);
});

// The raster list on a hires grid: lines past 511 need the tenth bit. A real
// program, built for the hires host, with the page's live rows set to the
// maximum before it runs, as the page does for a tall window.
test('raster entries survive lines past 511 on the hires host, in order', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { compile } = await import('../src/build.mjs');
  const { instantiateProgram, FrameLimitReached } = await import('../src/wasm-host.mjs');
  const { readRasterEntries } = await import('../src/web-scanline.mjs');
  const REPO = join(HERE, '..', '..', '..');
  const dir = await mkdtemp(join(tmpdir(), '8bs-web-hires-'));
  const prev = process.cwd();
  try {
    await writeFile(join(dir, 'main.8bs'), [
      'import { raster, Slot } from "@8bitscript/raster";',
      'export function main(): void {',
      '    raster.clear();',
      '    raster.at(300, Slot.BACKGROUND, 2);',
      '    raster.at(700, Slot.BACKGROUND, 5);',
      '    raster.insert(600, Slot.BORDER, 3);',
      '    raster.enable();',
      '    while (true) {',
      '        waitFrame();',
      '    }',
      '}',
      '',
    ].join('\n'));
    process.chdir(dir);
    const out = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    let result;
    try {
      result = await compile('web', join(dir, 'main.8bs'), { checkout: REPO, hardware: { machine: 'hifi-hires' } });
    } finally {
      process.stdout.write = out;
    }
    assert.equal(result.ok, true);
    const layout = layoutFromHardware(result.hardware);
    const { readFileSync } = await import('node:fs');
    let frame = 0;
    const program = await instantiateProgram(readFileSync(result.outFile), {
      waitFrame: () => { if ((frame += 1) > 2) throw new FrameLimitReached(2); },
    });
    const mem = new Uint8Array(program.memory.buffer);
    mem[layout.columnsOffset] = 80;
    mem[layout.rowsOffset] = HIRES_MAX_ROWS;
    try { program.entry(); } catch (error) { if (!(error instanceof FrameLimitReached)) throw error; }
    const { entries } = readRasterEntries(mem, layout);
    assert.deepEqual(entries.map((e) => [e.line, e.slot, e.value]), [[300, 1, 2], [600, 0, 3], [700, 1, 5]]);
  } finally {
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
});
