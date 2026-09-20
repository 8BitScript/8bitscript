// The loader is generated JavaScript, so the rules inside it are strings as
// far as Node is concerned. These tests evaluate the generated file and hold
// it to the module it was generated from: a rule that exists in two places
// has to be checked in both, or the copy in the template drifts silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { renderCoiServiceWorker, renderLoader, renderWorker } from '../src/web-loader.mjs';
import { renderHtml } from '../src/web-runtime.mjs';
import {
  ANY_BORDER_SCALE, BORDER_HAIRLINE_PX, BORDER_MIN_PX, BORDER_PX, FULL_BORDER_SCALE, HOST_OFFSET, HostStatus,
  INNER_H, INNER_W, INPUT_OFFSET, MIN_COLUMNS, MAX_COLUMNS, MIN_ROWS, MAX_ROWS,
  DEFAULT_LAYOUT, PET_PALETTE, RASTER_ENTRY_SIZE, RASTER_MAX_ENTRIES,
  MACHINE_HOST, agreementFor, borderFor, gridFor, layoutFromHardware, sidecarJson, swipeEdge,
} from '../src/web-layout.mjs';
import { dataBaseFor } from '@8bitscript/compiler/wasm';
import { Slot, renderFrame, rgbPalette } from '../src/web-scanline.mjs';

/** Evaluate the generated loader with no DOM at all and hand back its public object. */
function loadLoader(options) {
  const self = {};
  runInNewContext(renderLoader(options), { self, console });
  return self.EightBitScript;
}

test('the generated loader evaluates with no DOM and exposes mount() and the element name', () => {
  const api = loadLoader({ frameRate: 60 });
  assert.equal(typeof api.mount, 'function');
  assert.equal(api.elementName, 'eightbit-screen');
  assert.equal(api.defaultFrameRate, 60);
  assert.equal(api.layout.innerWidth, INNER_W);
  assert.equal(api.layout.innerHeight, INNER_H);
  assert.equal(api.layout.cols, 48);
  assert.equal(api.layout.rows, 27);
  assert.equal(api.layout.inputOffset, INPUT_OFFSET);
  assert.equal(api.layout.hostOffset, HOST_OFFSET);
  assert.equal(api.layout.aspect, '16/9');
  assert.equal(api.layout.fullBorder, BORDER_PX);
});

test('agreementFor places color RAM, input, and host status after the character grid', () => {
  const hi = agreementFor({ cols: 48, rows: 27 });
  assert.equal(hi.colorBase, 2 + 48 * 27);
  assert.equal(hi.inputOffset, hi.colorBase + 48 * 27);
  assert.equal(hi.hostOffset, hi.inputOffset + 1);
  assert.equal(hi.innerWidth, 384);
  assert.equal(hi.innerHeight, 216);
  const pet = agreementFor({ cols: 40, rows: 25, aspect: '4/3' });
  assert.equal(pet.inputOffset, 2002);
  assert.equal(pet.hostOffset, 2003);
  assert.equal(pet.aspect, '4/3');
  const vic = agreementFor({ cols: 22, rows: 23 });
  assert.equal(vic.colorBase, 508);
  assert.equal(vic.hostOffset, 1015);
});

// The raster region sits right after the host byte on every skin, fixed or
// resizable: control, count, then 64 three-byte entries. The same numbers are
// written down in packages/web/src/geometry.8bs and its twins, which have to
// agree.
test('the raster region follows HOST_OFFSET on every skin, and the sidecar carries it', () => {
  for (const options of [{ cols: 40, rows: 25 }, { cols: 22, rows: 23 }, { resizable: true }]) {
    const layout = agreementFor(options);
    assert.equal(layout.rasterControlOffset, layout.hostOffset + 1);
    assert.equal(layout.rasterCountOffset, layout.hostOffset + 2);
    assert.equal(layout.rasterBase, layout.hostOffset + 3);
    assert.equal(layout.rasterMaxEntries, RASTER_MAX_ENTRIES);
  }
  // The concrete numbers the geometry twins mirror.
  const c64 = agreementFor({ cols: 40, rows: 25 });
  assert.equal(c64.rasterControlOffset, 2004);
  assert.equal(c64.rasterBase, 2006);
  const modern = agreementFor({ resizable: true });
  assert.equal(modern.rasterControlOffset, 8198);
  assert.equal(modern.rasterCountOffset, 8199);
  assert.equal(modern.rasterBase, 8200);
  assert.equal(RASTER_ENTRY_SIZE, 3);
  const sidecar = sidecarJson(modern);
  assert.equal(sidecar.rasterControlOffset, 8198);
  assert.equal(sidecar.rasterCountOffset, 8199);
  assert.equal(sidecar.rasterBase, 8200);
  assert.equal(sidecar.rasterMaxEntries, RASTER_MAX_ENTRIES);
});

// The register agreement and the wasm backend's data section share one
// linear memory, and the only thing keeping a page's input write off a
// program's string literal is that the backend places data past the
// agreement's end. The end is agreementFor()'s to compute (reservedEnd),
// the placement is the compiler's (dataBaseFor); this pins that they agree
// for every host this CLI can lay out — the Modern host most of all, whose
// map sized for MAX_CELLS is what pushed the agreement past the backend's
// old fixed 8192.
test('the data section starts past the register agreement on every host: registers and data never overlap', () => {
  assert.equal(agreementFor({ cols: 48, rows: 27 }).reservedEnd, 2790, 'fixed 48×27: raster list ends at 2598 + 64 × 3');
  assert.equal(agreementFor({ cols: 40, rows: 25 }).reservedEnd, 2198);
  assert.equal(agreementFor({ resizable: true }).reservedEnd, 8392, 'Modern: past the old data base of 8192');
  for (const [machine, host] of Object.entries(MACHINE_HOST)) {
    const layout = layoutFromHardware({ facts: {}, options: { machine } });
    assert.equal(layout.resizable, host.resizable === true, machine);
    assert.equal(layout.reservedEnd, layout.rasterBase + RASTER_MAX_ENTRIES * RASTER_ENTRY_SIZE, machine);
    const dataBase = dataBaseFor(layout.reservedEnd);
    assert.ok(dataBase >= layout.reservedEnd, `${machine}: data at ${dataBase} would sit inside an agreement ending at ${layout.reservedEnd}`);
  }
  // The fixed skins keep their data where it always was; only Modern moves.
  assert.equal(dataBaseFor(layoutFromHardware({ facts: {}, options: { machine: 'c64' } }).reservedEnd), 8192);
  assert.equal(dataBaseFor(layoutFromHardware({ facts: {}, options: { machine: 'hifi' } }).reservedEnd), 8448);
});

// The two copies of borderFor — the one the build uses and the one that ships
// in the loader — are the same rule written twice. Check them against each
// other over the sizes that actually decide the answer.
test('the loader\'s borderFor agrees with web-layout.mjs on every boundary', () => {
  const { borderFor: inLoader } = loadLoader({ frameRate: 60 });
  const boxes = [
    { width: 393, height: 852, coarse: true },   // iPhone, upright
    { width: 852, height: 393, coarse: true },   // iPhone, sideways
    { width: 1080, height: 810, coarse: true },  // tablet
    { width: 1440, height: 900 },                // laptop
    { width: 1920, height: 1080 },               // desktop
    { width: 640, height: 400 },                 // an article column
    { width: INNER_W * ANY_BORDER_SCALE, height: INNER_H * ANY_BORDER_SCALE },
    { width: INNER_W * FULL_BORDER_SCALE, height: INNER_H * FULL_BORDER_SCALE },
    { width: 0, height: 0 },
    {},
  ];
  for (const box of boxes) {
    assert.equal(inLoader(box), borderFor(box), `borderFor(${JSON.stringify(box)})`);
  }
});

test('the loader\'s swipeEdge agrees with web-layout.mjs', () => {
  const { swipeEdge: inLoader } = loadLoader({ frameRate: 60 });
  for (const [dx, dy] of [[0, 0], [40, 0], [-40, 0], [0, 40], [0, -40], [27, 27], [50, 49], [-9, -60]]) {
    assert.equal(inLoader(dx, dy), swipeEdge(dx, dy), `swipeEdge(${dx}, ${dy})`);
  }
});

// The stated ask this rule exists for: a phone gets the picture, not a frame,
// in either orientation.
test('a phone gets the thinnest border in either orientation, and a desktop keeps the full one', () => {
  assert.equal(borderFor({ width: 393, height: 852, coarse: true }), BORDER_MIN_PX);
  assert.equal(borderFor({ width: 852, height: 393, coarse: true }), BORDER_MIN_PX);
  assert.equal(borderFor({ width: 1920, height: 1080 }), BORDER_PX);
});

// The border is a channel, not just a frame: screen.setBorder() is how a
// program says something about the whole screen at once, and 2048 turns it red
// on game over. A border of zero would delete that on exactly the devices most
// people play on, so no box — however small — ever gets one.
test('no box ever gets a zero border', () => {
  for (const box of [
    { width: 393, height: 852, coarse: true },
    { width: 852, height: 393, coarse: true },
    { width: 320, height: 180 },
    { width: 1, height: 1 },
    { width: INNER_W, height: INNER_H },
  ]) {
    assert.ok(borderFor(box) > 0, `borderFor(${JSON.stringify(box)}) must be > 0`);
  }
});

test('a touch screen big enough for a border still only gets the hairline', () => {
  const big = { width: INNER_W * 4, height: INNER_H * 4 };
  assert.equal(borderFor(big), BORDER_PX);
  assert.equal(borderFor({ ...big, coarse: true }), BORDER_HAIRLINE_PX);
});

// A container that has not been laid out yet is not a small screen. Guessing
// "phone" there would flash a borderless frame before the real size arrives.
test('an unmeasured box gets the full border, not the smallest one', () => {
  assert.equal(borderFor({}), BORDER_PX);
  assert.equal(borderFor({ width: 0, height: 0 }), BORDER_PX);
  assert.equal(borderFor(undefined), BORDER_PX);
});

test('the loader carries the worker inline so it can be served from another origin', () => {
  const source = renderLoader({ frameRate: 60 });
  // new Worker('worker.js') is blocked cross-origin; a blob: URL is not.
  assert.match(source, /URL\.createObjectURL\(new Blob\(\[WORKER_SOURCE\]/);
  assert.match(source, /var WORKER_SOURCE = "/);
  // ...and the same worker is still writable as a file, for pages whose CSP
  // forbids blob: workers.
  assert.match(renderWorker(), /Atomics\.wait/);
});

// Under a blob: URL, self.location.href is blob:<origin>/<uuid> and resolving
// a relative path against it produces nothing useful — so the page resolves
// the wasm URL and sends it.
test('the wasm URL is resolved on the page and passed to the worker, not guessed', () => {
  assert.match(renderLoader({ frameRate: 60 }), /new URL\(src, document\.baseURI\)\.href/);
  assert.match(renderLoader({ frameRate: 60 }), /wasmUrl: wasmUrl/);
  assert.match(renderWorker(), /data: \{ ctrl, wasmUrl,/);
  assert.doesNotMatch(renderWorker(), /new URL\('program\.wasm'/);
});

// applyLayout() applies the program's own compiled sidecar (program.json) —
// palette, aspect, register offsets — on every mount, including the Modern
// host's resizable one. Its cols/rows there are the compiled DEFAULT
// (48x27), not a live measurement, so letting it overwrite INNER_W/INNER_H
// on a resizable host clobbers whatever resize() already computed from the
// real window — and silently: applyGrid()'s own change check only compares
// gridCols/gridRows (untouched by applyLayout), so the very next resize()
// sees "no change" and skips fixing INNER_W/INNER_H back. The canvas then
// paints at one grid while the program — and the postMessage grid write
// above — uses another: the same sheared-text failure as the race, from an
// unrelated cause. A fixed skin still needs cols/rows applied here, since
// those genuinely vary by machine.
test('applyLayout does not overwrite the live grid on a resizable host', () => {
  const source = renderLoader({ frameRate: 60 });
  const fn = source.slice(source.indexOf('function applyLayout('), source.indexOf('function resolveHost('));
  assert.match(fn, /if \(!RESIZABLE\) \{/);
  // cols/rows/INNER_W/INNER_H must all be inside that guard...
  const guardBody = fn.slice(fn.indexOf('if (!RESIZABLE) {'), fn.indexOf('if (next.charBase'));
  assert.match(guardBody, /GRID_COLS = next\.cols/);
  assert.match(guardBody, /GRID_ROWS = next\.rows/);
  assert.match(guardBody, /INNER_W = GRID_COLS \* CHAR_W/);
  assert.match(guardBody, /INNER_H = GRID_ROWS \* CHAR_H/);
  // ...but every other field (palette, aspect, register offsets) still
  // applies unconditionally, on every host.
  assert.doesNotMatch(fn.slice(fn.indexOf('if (next.charBase')), /RESIZABLE/);
  assert.match(fn, /if \(next\.aspect\) ASPECT = next\.aspect/);
  assert.match(fn, /if \(next\.palette && next\.palette\.length\) COLORS = next\.palette/);
});

// A program's own first text.columns() read — inside its start-up layout,
// before it ever calls waitFrame() — races the page's data.memory handler:
// postMessage back to the page is fire-and-forget, so the worker calling
// entry() right after posting its memory can run that first read before
// the page has processed data.memory and written the live grid. The
// worker has to write its own copy of the grid into its own memory,
// before entry() runs, using what the page already measured and sent
// with the start message — not wait on a round trip back from the page.
test('the worker writes the grid into its own memory before calling entry, not after', () => {
  const source = renderLoader({ frameRate: 60 });
  // The page sends what it already measured, not just ctrl/wasmUrl.
  assert.match(source, /resizable: RESIZABLE/);
  assert.match(source, /columnsOffset: COLUMNS_OFFSET/);
  assert.match(source, /rowsOffset: ROWS_OFFSET/);
  assert.match(source, /gridCols: gridCols/);
  assert.match(source, /gridRows: gridRows/);

  const worker = renderWorker();
  assert.match(worker, /resizable, columnsOffset, rowsOffset, gridCols, gridRows/);
  assert.match(worker, /mem\[columnsOffset\] = gridCols/);
  assert.match(worker, /mem\[rowsOffset\] = gridRows/);
  // Ordering, not just presence: the grid write has to be textually before
  // entry() is called, since this is one straight-line async function with
  // no branch that could reorder them at runtime.
  const writeAt = worker.indexOf('mem[columnsOffset] = gridCols');
  const entryAt = worker.indexOf('entry();');
  assert.ok(writeAt > 0 && entryAt > 0 && writeAt < entryAt);
});

// An embedded screen is a guest on somebody else's page: it must not take the
// whole document's arrow keys, and it must not post to their /status.
test('the loader stays inside its own element when embedded', () => {
  const source = renderLoader({ frameRate: 60 });
  assert.match(source, /keyboard = options\.keyboard \|\| \(fullPage \? 'window' : 'focus'\)/);
  assert.match(source, /keyTarget = keyboard === 'window' \? global : root/);
  assert.doesNotMatch(source, /\/status/);
  // Sizing embedded comes from the container, not the browser window.
  assert.match(source, /new ResizeObserver\(resize\)/);
});

// Assigning canvas.width/height clears the canvas and resets the 2D context,
// so it must happen only when the border actually changed, never per frame.
// Assigning canvas.width/height clears the canvas and resets every bit of 2D
// context state, so it happens only when the picture actually changed shape:
// a new border, or — on the Modern host — a new grid under it.
test('the canvas is only re-dimensioned when the border or the grid changes', () => {
  const source = renderLoader({ frameRate: 60 });
  assert.match(source, /if \(next !== border \|\| regridded\) \{\s*\n\s*border = next;\s*\n\s*canvas\.width = INNER_W \+ border \* 2;/);
});

// A resize lands between frames (8BX spec §74, decided 2026-09-16): while a
// waitFrame() program runs, the page holds the measurement and re-grids in
// tick(), right before releasing the next frame and only once the program
// has consumed every frame issued — so it is blocked in waitFrame() and can
// never see columns() change between two reads inside one frame. A program
// with no frame clock is re-gridded at once, as it always was.
test('a resize re-grids between frames, never mid-frame', () => {
  const source = renderLoader({ frameRate: 60 });
  const resize = source.slice(source.indexOf('function resize()'), source.indexOf('function relayout('));
  assert.match(resize, /if \(ctrl && !destroyed\) \{\s*\n\s*pendingMeasure = measured;\s*\n\s*fit\(measured\);\s*\n\s*return;/);
  assert.match(resize, /relayout\(measured\);/, 'no frame clock: at once');
  const tick = source.slice(source.indexOf('function tick(now)'), source.indexOf('function start()'));
  const applyAt = tick.indexOf('relayout(pendingMeasure)');
  const issueAt = tick.indexOf('Atomics.add(ctrl, ISSUED, 1)');
  assert.ok(applyAt > 0 && issueAt > applyAt, 'the pending grid is applied before the frame is released');
  assert.match(tick, /pendingMeasure !== null && Atomics\.load\(ctrl, ISSUED\) === Atomics\.load\(ctrl, CONSUMED\)/,
    'and only once the program is waiting');
  // The memory write is inside relayout (via applyGrid), nowhere else on the page.
  const relayout = source.slice(source.indexOf('function relayout('), source.indexOf('function fit('));
  assert.match(relayout, /applyGrid\(measured\)/);
  // The memory write happens in applyGrid (a re-grid) and once when the
  // worker hands its memory over — never straight from a resize event.
  const writes = [...source.matchAll(/writeGrid\(\);/g)].length;
  assert.equal(writes, 2, 'writeGrid: applyGrid and the memory hand-off only');
});

// The grid rule, like borderFor, exists twice — here and in web-layout.mjs —
// and a rule that lives only inside a template string is a rule nothing can
// test.
test("the loader's gridFor agrees with web-layout.mjs on every shape", () => {
  const { gridFor: inLoader } = loadLoader({ frameRate: 60 });
  for (const box of [
    { width: 1920, height: 1080 },
    { width: 1080, height: 1920 },
    { width: 1024, height: 768 },
    { width: 2560, height: 1080 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 0, height: 0 },
    undefined,
  ]) {
    // Field by field: the loader is evaluated in its own realm, so its object
    // does not share a prototype with ours.
    const mine = gridFor(box);
    const theirs = inLoader(box);
    assert.equal(theirs.cols, mine.cols, `gridFor(${JSON.stringify(box)}).cols`);
    assert.equal(theirs.rows, mine.rows, `gridFor(${JSON.stringify(box)}).rows`);
  }
});

// 16:9 is the shape this host has always had, and it must keep answering with
// the grid every existing build and screenshot was made against.
test('a 16:9 window still gets exactly 48x27', () => {
  assert.equal(gridFor({ width: 1920, height: 1080 }).cols, 48);
  assert.equal(gridFor({ width: 1920, height: 1080 }).rows, 27);
  assert.equal(gridFor({ width: 384, height: 216 }).cols, 48);
  assert.equal(gridFor({ width: 384, height: 216 }).rows, 27);
});

// A grid too small to lay anything out on is not a better answer than one that
// letterboxes, so the shape follows the window only between the bounds.
test('an extreme window is clamped, not followed', () => {
  const sliver = gridFor({ width: 200, height: 2000 });
  assert.ok(sliver.cols >= MIN_COLUMNS && sliver.cols <= MAX_COLUMNS);
  assert.ok(sliver.rows >= MIN_ROWS && sliver.rows <= MAX_ROWS);
  const strip = gridFor({ width: 4000, height: 300 });
  assert.ok(strip.cols >= MIN_COLUMNS && strip.cols <= MAX_COLUMNS);
  assert.ok(strip.rows >= MIN_ROWS && strip.rows <= MAX_ROWS);
});

// The Modern host's map is sized for the biggest grid it will ever hand out,
// so an offset never moves when the window turns. These numbers are also
// written down in packages/web/src/geometry.8bs, which has to agree.
test('a resizable agreement is mapped for the maximum grid, a fixed one is packed', () => {
  const modern = agreementFor({ resizable: true });
  assert.equal(modern.charBase, 4);
  assert.equal(modern.colorBase, 4100);
  assert.equal(modern.inputOffset, 8196);
  assert.equal(modern.hostOffset, 8197);
  for (const [cols, rows] of [[27, 48], [42, 31], [64, 20]]) {
    const turned = agreementFor({ cols, rows, resizable: true });
    assert.equal(turned.charBase, modern.charBase);
    assert.equal(turned.colorBase, modern.colorBase);
    assert.equal(turned.inputOffset, modern.inputOffset);
    assert.equal(turned.hostOffset, modern.hostOffset);
  }
  // A machine skin is unchanged: a C64 is 40x25 and packed right behind it.
  const c64 = agreementFor({ cols: 40, rows: 25 });
  assert.equal(c64.charBase, 2);
  assert.equal(c64.colorBase, 1002);
  assert.equal(c64.inputOffset, 2002);
  assert.equal(c64.hostOffset, 2003);
});

// The compositor, like borderFor, exists twice — web-scanline.mjs and the
// loader's inlined copy — and the two have to paint the same pixels. The
// loader's paint() only needs a canvas-shaped object that can hand out and
// take back an ImageData, so that is all the stub is.
test("the loader's paint() agrees with web-scanline.mjs's renderFrame, pixel for pixel", () => {
  const layout = DEFAULT_LAYOUT;
  const mem = new Uint8Array(65536);
  mem[0] = 2; // border: red
  mem[1] = 3; // background: cyan
  mem[layout.charBase + 0] = 65; // 'A' in white at cell 0
  mem[layout.colorBase + 0] = 1;
  mem[layout.charBase + 96] = 0; // a reverse-video blank at row 2, col 0
  mem[layout.colorBase + 96] = 0x81;
  mem[layout.charBase + 150] = 122; // 'z' in yellow inside the scroll band
  mem[layout.colorBase + 150] = 7;
  // A border split, a background band, and a SCROLL_X band, ascending — the
  // order rasterline.8bs's at() enforces.
  const entries = [
    [16, Slot.BORDER, 5], [16, Slot.BACKGROUND, 6], [24, Slot.SCROLL_X, 3],
  ];
  entries.forEach(([line, slot, value], i) => {
    mem[layout.rasterBase + i * 3] = line;
    mem[layout.rasterBase + i * 3 + 1] = slot;
    mem[layout.rasterBase + i * 3 + 2] = value;
  });
  mem[layout.rasterCountOffset] = entries.length;
  mem[layout.rasterControlOffset] = 1;

  const mine = renderFrame(mem, { ...layout, border: BORDER_PX }, rgbPalette(layout.palette));

  const api = loadLoader({ frameRate: 60 });
  let image = null;
  const ctx = {
    canvas: { width: mine.width, height: mine.height },
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(next) { image = next; },
  };
  api.paint(ctx, mem, BORDER_PX);
  assert.ok(image, 'paint() must put an ImageData back');
  assert.equal(image.width, mine.width);
  assert.equal(image.height, mine.height);
  assert.ok(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength)
    .equals(Buffer.from(mine.rgba)), 'the two compositors must paint identical pixels');
});

/** Write an entry the way rasterline.8bs's at() stores it: line's ninth bit in the slot byte's bit 7. */
function storeEntry(mem, layout, index, line, slot, value) {
  mem[layout.rasterBase + index * 3] = line % 256;
  mem[layout.rasterBase + index * 3 + 1] = slot | (Math.floor(line / 256) << 7);
  mem[layout.rasterBase + index * 3 + 2] = value;
}

/** renderFrame and the generated loader's paint() over the same memory, pixel-compared. */
function assertPaintParity(layout, mem) {
  const mine = renderFrame(mem, { ...layout, border: BORDER_PX }, rgbPalette(layout.palette));
  const api = loadLoader({ frameRate: 60, layout });
  let image = null;
  const ctx = {
    canvas: { width: mine.width, height: mine.height },
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(next) { image = next; },
  };
  api.paint(ctx, mem, BORDER_PX);
  assert.ok(image, 'paint() must put an ImageData back');
  assert.ok(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength)
    .equals(Buffer.from(mine.rgba)), 'the two compositors must paint identical pixels');
  return mine;
}

function framePixel(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2]];
}

// The PET skin has no per-cell color, but BORDER and BACKGROUND entries still
// resolve through its black/green palette — in the loader exactly as in the
// screenshot rasterizer.
test('the loader paints the PET skin with all three slots applied, identically to renderFrame', () => {
  const layout = agreementFor({
    cols: 40, rows: 25, palette: PET_PALETTE, aspect: '4/3', colorPerCell: false, font: 'pet',
  });
  const mem = new Uint8Array(65536);
  mem[layout.colorBase + 12 * 40] = 0x80; // reverse blank, cell row 12, col 0
  mem[layout.colorBase + 13 * 40] = 0x80; // ...and row 13, inside the band
  storeEntry(mem, layout, 0, 100, Slot.BORDER, 5);
  storeEntry(mem, layout, 1, 104, Slot.SCROLL_X, 4);
  storeEntry(mem, layout, 2, 120, Slot.BACKGROUND, 5);
  mem[layout.rasterCountOffset] = 3;
  mem[layout.rasterControlOffset] = 1;
  const frame = assertPaintParity(layout, mem);
  // ...and the entries really land: the border turns green at line 100, the
  // background at 120, and the band's vacated columns stay black.
  const green = [0x55, 0xff, 0x55];
  assert.deepEqual(framePixel(frame, 0, BORDER_PX + 99), [0, 0, 0]);
  assert.deepEqual(framePixel(frame, 0, BORDER_PX + 100), green);
  assert.deepEqual(framePixel(frame, BORDER_PX + 300, BORDER_PX + 120), green);
  assert.deepEqual(framePixel(frame, BORDER_PX + 0, BORDER_PX + 104), [0, 0, 0]);
  assert.deepEqual(framePixel(frame, BORDER_PX + 4, BORDER_PX + 104), green);
});

// A resizable portrait grid is 384 picture lines tall; an entry past line 255
// carries its ninth bit in the slot byte, and the loader decodes it exactly
// as web-scanline.mjs does.
test('the loader splits a tall resizable grid below line 255, identically to renderFrame', () => {
  const layout = agreementFor({ cols: 27, rows: 48, resizable: true });
  const mem = new Uint8Array(65536);
  mem[0] = 2; // border: red
  mem[1] = 3; // background: cyan
  storeEntry(mem, layout, 0, 300, Slot.BORDER, 5);
  storeEntry(mem, layout, 1, 300, Slot.BACKGROUND, 6);
  mem[layout.rasterCountOffset] = 2;
  mem[layout.rasterControlOffset] = 1;
  const frame = assertPaintParity(layout, mem);
  const rgb = rgbPalette(layout.palette);
  assert.deepEqual(framePixel(frame, 0, BORDER_PX + 299), rgb[2]);
  assert.deepEqual(framePixel(frame, 0, BORDER_PX + 300), rgb[5]);
  assert.deepEqual(framePixel(frame, BORDER_PX + 100, BORDER_PX + 300), rgb[6]);
});

test('the loader writes HOST_OFFSET from maxTouchPoints and pointer:coarse, and loads a sidecar', () => {
  const source = renderLoader({ frameRate: 60 });
  assert.match(source, /HOST_OFFSET/);
  assert.match(source, /function hostIsTouch/);
  assert.match(source, /maxTouchPoints/);
  assert.match(source, /pointer: coarse/);
  assert.match(source, /\.json/);
  assert.match(source, /applyLayout/);
  assert.doesNotMatch(source, /mem\[HOST_OFFSET\] = 1/);
});

// The keyboard bit is the one level in the host byte that can change: a
// phone starts without one, and the first real key — not one typed into a
// form field, not one a script made — writes the byte again.
test('the loader sets NO_KEYBOARD from hover:none on a touch host, and clears it on the first trusted key', () => {
  const source = renderLoader({ frameRate: 60 });
  assert.match(source, new RegExp(`var HOST_NO_KEYBOARD = ${HostStatus.NO_KEYBOARD};`));
  assert.match(source, /function hostHasKeyboard\(sawKey\)/);
  assert.match(source, /hover: none/);
  assert.match(source, /if \(!hostHasKeyboard\(sawKey\)\) status \|= HOST_NO_KEYBOARD;/);
  assert.match(source, /e\.isTrusted === false \|\| isTextField\(e\.target\)/);
  // noteKey runs before the arrow is looked up, so the key that proves the
  // keyboard is also the first move it makes.
  assert.match(source, /function onKeyDown\(e\) \{\n\s*noteKey\(e\);/);
  // The start-up guess is the page's to read too, so a shell can word its
  // hint the way the program words its prompt. No DOM here: no navigator,
  // no matchMedia, so the answers are a desktop's.
  const api = loadLoader({ frameRate: 60 });
  assert.equal(api.hostIsTouch(), false);
  assert.equal(api.hostHasKeyboard(), true);
  assert.match(renderHtml(60), /hint: EightBitScript\.hostHasKeyboard\(\)/);
});

test('the loader says what is wrong when the page is not cross-origin isolated', () => {
  const source = renderLoader({ frameRate: 60 });
  assert.match(source, /typeof SharedArrayBuffer !== 'undefined' && global\.crossOriginIsolated !== false/);
  assert.match(source, /Cross-Origin-Opener-Policy: same-origin/);
  assert.match(source, /load coi\.js first/);
});

// The shim is one file playing two parts; `window` is what tells them apart.
test('coi.js is both the page script and the service worker it registers', () => {
  const source = renderCoiServiceWorker();
  assert.match(source, /typeof window === 'undefined'/);
  assert.match(source, /addEventListener\('fetch'/);
  assert.match(source, /headers\.set\('Cross-Origin-Embedder-Policy', 'require-corp'\)/);
  assert.match(source, /headers\.set\('Cross-Origin-Opener-Policy', 'same-origin'\)/);
  // A service worker needs a secure context; on plain http:// it must not try.
  assert.match(source, /window\.isSecureContext/);
  // And it must say out loud what it does to the rest of the page.
  assert.match(source, /require-corp to EVERY response on this origin/);
});
