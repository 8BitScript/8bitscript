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
  C64_PALETTE, DEFAULT_LAYOUT, PET_PALETTE, VERA_PALETTE, VIC20_PALETTE, RASTER_ENTRY_SIZE, RASTER_MAX_ENTRIES, GLYPH_BYTES, GLYPH_FIRST,
  MACHINE_HOST, agreementFor, borderFor, gridFor, layoutForRealMachine, layoutFromHardware, sidecarJson, swipeEdge,
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
  assert.equal(api.layout.pixelAspect, 1, 'square pixels unless a real machine measured otherwise');
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

test('agreementFor: pixelAspect defaults to 1 (square) and passes through unchanged otherwise', () => {
  assert.equal(agreementFor({ cols: 48, rows: 27 }).pixelAspect, 1);
  assert.equal(agreementFor({ cols: 22, rows: 23, pixelAspect: 5 / 3 }).pixelAspect, 5 / 3);
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
  assert.equal(sidecar.pixelAspect, 1, 'sidecarJson carries pixelAspect through too, for the page to read');
  assert.equal(sidecarJson(layoutForRealMachine('vic20', { facts: { 'video.frameRate': 60 } })).pixelAspect, 5 / 3);
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
    // The synthetic hosts carry the redefinable glyph table after the raster list.
    assert.equal(layout.glyphBase, layout.rasterBase + RASTER_MAX_ENTRIES * RASTER_ENTRY_SIZE, machine);
    // And the four tone registers after that.
    assert.equal(layout.audioBase, layout.glyphBase + GLYPH_BYTES, machine);
    assert.equal(layout.reservedEnd, layout.audioBase + 4, machine);
    const dataBase = dataBaseFor(layout.reservedEnd);
    assert.ok(dataBase >= layout.reservedEnd, `${machine}: data at ${dataBase} would sit inside an agreement ending at ${layout.reservedEnd}`);
  }
  // The fixed skins keep their data where it always was; only Modern moves.
  assert.equal(dataBaseFor(layoutFromHardware({ facts: {}, options: { machine: 'c64' } }).reservedEnd), 8192);
  assert.equal(dataBaseFor(layoutFromHardware({ facts: {}, options: { machine: 'hifi' } }).reservedEnd), 9216, 'Modern: past the glyph table (which ends at 9032) and the tone registers (9036)');
});

// layoutFromHardware() computes charBase/colorBase from grid size because
// the *synthetic* target's own .8bs source was written to match that
// math. A real machine's own package (packages/pet/src/text.8bs) was
// written against its actual hardware's memory map instead — the first
// real run of this confirmed it the hard way, painting a blank screen
// because nothing sat at the synthetic offset agreementFor() computed.
test('layoutForRealMachine: PET keeps its real $8000 screen address and its own palette — never the synthetic offsets — and a 2001 build gets its own captured font, needing no glyph translation at all', () => {
  // video.characterSetSwapped is true only for the 2001 (packages/pet's
  // own catalog), which is what a 2001 build actually is.
  const layout = layoutForRealMachine('pet', { facts: { 'video.columns': 40, 'video.rows': 25, 'video.characterSetSwapped': true } });
  assert.equal(layout.charBase, 0x8000, 'PET screen RAM, not a synthetic offset near the low hundreds');
  assert.equal(layout.colorPerCell, false, 'PET has no color RAM');
  assert.deepEqual(layout.palette, PET_PALETTE);
  assert.equal(layout.aspect, '4/3');
  // font8x8.mjs's own PET_2001_SCREENCODE table is indexed by the PET's
  // own screen code already — text.8bs's asciiToScreenCode() did the only
  // translation this ever needed before a byte reached here — so a 2001
  // build names that table and nothing else.
  // The machine boots in graphics and upper case; $E84C bit 1 names the text
  // set (the 2001's own ROM, the swapped one), so the layout names both.
  assert.equal(layout.font, 'pet-2001-graphics-screencode');
  assert.equal(layout.fontAlt, 'pet-2001-screencode');
  assert.deepEqual(layout.charsetSwitch, { register: 0xe84c, mask: 0x02 });
  // The data section still has to land past whatever this build's own
  // agreement reserves — true here only because 0x8000 happens to sit
  // far past any synthetic reservedEnd, not because this function checked:
  // a future real machine whose screen sits *below* that floor would need
  // this guarded for real, not just observed to hold today.
  assert.ok(dataBaseFor(layout.reservedEnd) < layout.charBase, 'PET screen RAM sits past this build\'s own data section');

  // A machine with no entry at all gets geometry only, as
  // layoutFromHardware would have given — not a crash and not a silently
  // wrong charBase of 0x8000 (c64 has had its own entry since its wasm port).
  const noEntry = layoutForRealMachine('atari8', { facts: { 'video.columns': 40, 'video.rows': 25 } });
  assert.notEqual(noEntry.charBase, 0x8000);
  assert.equal(noEntry.vic, undefined);
});

test('layoutForRealMachine: a later (non-swapped) PET model gets its own captured ROM too, not the 2001\'s and not the shared ASCII fallback', () => {
  const layout = layoutForRealMachine('pet', { facts: { 'video.columns': 40, 'video.rows': 25, 'video.characterSetSwapped': false } });
  // font8x8.mjs's PET_TEXT_SCREENCODE table (ROM 901447-10, shared by
  // every non-2001 model) is indexed by the PET's own screen code the
  // same way the 2001's is — no glyphIndexFn here either.
  assert.equal(layout.font, 'pet-graphics-screencode');
  assert.equal(layout.fontAlt, 'pet-text-screencode');
  assert.deepEqual(layout.charsetSwitch, { register: 0xe84c, mask: 0x02 });
});

test('layoutForRealMachine: VIC-20\'s screen moves with its own RAM, not with a formula — unexpanded keeps $1E00/$9600, `expanded` moves to $1000/$9400, and it keeps its own palette and real per-cell color RAM', () => {
  const facts = { 'video.columns': 22, 'video.rows': 23 };
  const unexpanded = layoutForRealMachine('vic20', { facts, tags: [] });
  assert.equal(unexpanded.charBase, 0x1e00, 'the stock 3583-byte VIC-20\'s own screen address');
  assert.equal(unexpanded.colorBase, 0x9600);

  const expanded = layoutForRealMachine('vic20', { facts, tags: ['expanded'] });
  assert.equal(expanded.charBase, 0x1000, 'the KERNAL relocates the screen once 8K or more is fitted');
  assert.equal(expanded.colorBase, 0x9400);

  assert.equal(unexpanded.colorPerCell, true, 'the VIC-20 has real per-cell color RAM, unlike the PET');
  assert.deepEqual(unexpanded.palette, VIC20_PALETTE);
  // font8x8.mjs's VIC20_TEXT_SCREENCODE table, read directly out of
  // VICE's own chargen-901460-03.bin — indexed by the VIC-20's own screen
  // code, so this needs no glyphIndexFn either.
  // It boots in the upper case and graphics set; the low nybble of $9005
  // names the lower/upper set (nybble 2, $8800).
  assert.equal(unexpanded.font, 'vic20-upper-screencode');
  assert.equal(unexpanded.fontAlt, 'vic20-text-screencode');
  assert.deepEqual(unexpanded.charsetSwitch, { register: 0x9005, mask: 0x0e });
  // No video.frameRate fact given: the honest default, same as PAL until
  // that chip's own timing is measured — see the NTSC test below for the
  // one machine/region this project has actually measured.
  assert.equal(unexpanded.pixelAspect, 1);
});

test('layoutForRealMachine: VIC-20 NTSC (6560) draws non-square pixels — measured from the chip\'s own timing, not guessed, and the outer aspect is derived from it rather than a flat \'4/3\'', () => {
  const facts = { 'video.columns': 22, 'video.rows': 23, 'video.frameRate': 60 };
  const ntsc = layoutForRealMachine('vic20', { facts, tags: [] });
  assert.equal(ntsc.pixelAspect, 5 / 3);
  // 22 cols * 8px * 5/3 wide : 23 rows * 8px tall — not the flat '4/3'
  // guess every other real-machine entry still uses.
  assert.equal(ntsc.aspect, `${22 * 8 * (5 / 3)}/${23 * 8}`);
  // PAL (or an unknown region) keeps square pixels and the flat '4/3'
  // fallback — an honest gap, not a wrong number: this project has not
  // measured the 6561's own (different) cycles-per-line timing yet.
  const pal = layoutForRealMachine('vic20', { facts: { ...facts, 'video.frameRate': 50 }, tags: [] });
  assert.equal(pal.pixelAspect, 1);
  assert.equal(pal.aspect, '4/3');
});

test('layoutForRealMachine: cx16 has no real fixed VRAM address to substitute (VERA is port-only, even on real hardware) — memoryFor is a deliberate no-op, so it keeps agreementFor()\'s own charBase/colorBase for its own 76x56 grid', () => {
  const layout = layoutForRealMachine('cx16', { facts: { 'video.columns': 76, 'video.rows': 56, 'video.colorPerCell': true } });
  assert.equal(layout.charBase, 2, 'the synthetic default — text.cx16.web.8bs writes here, not a real VERA address');
  assert.equal(layout.colorBase, 2 + 76 * 56);
  assert.equal(layout.colorPerCell, true);
  assert.deepEqual(layout.palette, VERA_PALETTE, 'VERA\'s default palette: the C64\'s names and order, with VERA\'s own colours');
  assert.notDeepEqual(layout.palette, C64_PALETTE, 'not the C64\'s RGB — blue is #0000aa, as x16emu draws it');
  assert.equal(layout.aspect, '4/3');
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

// fit() stretches the canvas's *displayed* size by PIXEL_ASPECT, never
// canvas.width/height (the real pixel buffer paint() draws into and every
// offset above indexes into) — a real machine with non-square pixels
// (VIC-20 NTSC) needs the browser to stretch what is already painted, not
// a differently-shaped buffer with different math for every offset.
test('fit() stretches the canvas\'s displayed width by PIXEL_ASPECT, never its real pixel buffer', () => {
  const source = renderLoader({ frameRate: 60, layout: { ...DEFAULT_LAYOUT, pixelAspect: 5 / 3 } });
  const fit = source.slice(source.indexOf('function fit(measured)'), source.indexOf('var observer = null;'));
  assert.match(fit, /measured\.width \/ \(canvas\.width \* PIXEL_ASPECT\)/, 'the fit scale accounts for the stretch before comparing to the measured box');
  assert.match(fit, /canvas\.width \* PIXEL_ASPECT \* scale/, 'canvas.style.width is stretched; canvas.width itself is read, never assigned, in this function');
  assert.doesNotMatch(fit, /canvas\.width\s*=/, 'fit() never resizes the real pixel buffer — that is relayout()\'s job, and unaffected by PIXEL_ASPECT');
});

test('PIXEL_ASPECT defaults to 1 and is only ever set from layout.pixelAspect', () => {
  const square = renderLoader({ frameRate: 60 });
  assert.match(square, /var PIXEL_ASPECT = 1;/);
  const wide = renderLoader({ frameRate: 60, layout: { ...DEFAULT_LAYOUT, pixelAspect: 5 / 3 } });
  assert.match(wide, new RegExp(`var PIXEL_ASPECT = ${(5 / 3).toString().replace('.', '\\.')};`));
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

// The C64's wasm build is painted out of the program's own memory the way a
// VIC-II reads it: glyphs from the character RAM (layout.vic), the border and
// background from $D020/$D021, the scroll from $D016, the live set from $D018
// bit 1, and a raster list's CHARSET entry over it. The loader's inlined copy
// has to paint exactly what renderFrame does for all of it.
test("the loader paints the C64's register-driven picture, identically to renderFrame", () => {
  const layout = layoutForRealMachine('c64', { facts: { 'video.columns': 40, 'video.rows': 25 } });
  const vic = layout.vic;
  const mem = new Uint8Array(65536);
  // Two sets of recognisable glyphs: set 0 glyph 1 is a left-half block, set 1 glyph 1 a right-half block.
  for (let row = 0; row < 8; row += 1) {
    mem[vic.charsetBase + 8 + row] = 0xf0;
    mem[vic.charsetBase + vic.setStride + 8 + row] = 0x0f;
  }
  mem[0xd020] = 14; // border: light blue
  mem[0xd021] = 6; // background: blue
  mem[0xd016] = 0xc8 | 3; // 40 columns, fine scroll 3 (only the low three bits count)
  mem[0xd018] = 0x84; // set 0
  for (let cell = 0; cell < 1000; cell += 1) {
    const col = cell % 40;
    mem[layout.charBase + cell] = col % 3 === 0 ? 1 : 32;
    mem[layout.colorBase + cell] = (col % 16) | 0xf0; // the high nybble of colour RAM is not part of the colour
  }
  let frame = assertPaintParity(layout, mem);
  const rgb = rgbPalette(layout.palette);
  assert.deepEqual(framePixel(frame, 2, 2), rgb[14], 'the border is $D020');
  // Cell 0 is glyph 1 in colour 0 (black): its left half is ink, shifted right by the scroll of 3.
  assert.deepEqual(framePixel(frame, BORDER_PX + 3, BORDER_PX), rgb[0]);
  assert.deepEqual(framePixel(frame, BORDER_PX + 3 + 4, BORDER_PX), rgb[6], 'the right half is the background');
  assert.deepEqual(framePixel(frame, BORDER_PX, BORDER_PX), rgb[6], 'the scroll leaves the first columns background');

  // $D018 bit 1 set: the other set. Cell 1 is a blank, so cell 3 (glyph 1, colour 3) shows the right half.
  mem[0xd018] = 0x86;
  frame = assertPaintParity(layout, mem);
  assert.deepEqual(framePixel(frame, BORDER_PX + 3 + 8 * 3 + 4, BORDER_PX), rgb[3]);
  assert.deepEqual(framePixel(frame, BORDER_PX + 3 + 8 * 3, BORDER_PX), rgb[6]);

  // A raster CHARSET entry overrides the register from its line: back to set 0 below picture line 8.
  storeEntry(mem, layout, 0, 8, Slot.CHARSET, 0);
  mem[layout.rasterCountOffset] = 1;
  mem[layout.rasterControlOffset] = 1;
  frame = assertPaintParity(layout, mem);
  assert.deepEqual(framePixel(frame, BORDER_PX + 3 + 8 * 3, BORDER_PX), rgb[6], 'above the entry: $D018\'s set 1');
  assert.deepEqual(framePixel(frame, BORDER_PX + 3 + 8 * 3, BORDER_PX + 8), rgb[3], 'from the entry down: set 0');
});

// The VIC-20 keeps its border and background in one register ($900F) and its
// character set in the low nibble of another ($9005): the loader's copy reads
// the same bytes the compositor does, and a raster entry still overrides them.
test("the loader paints the VIC-20's packed-register picture, identically to renderFrame", () => {
  const layout = layoutForRealMachine('vic20', { facts: { 'video.columns': 22, 'video.rows': 23, 'video.frameRate': 60 }, tags: [] });
  assert.deepEqual(layout.packedRegisters.colorRegister, 0x900f);
  const mem = new Uint8Array(65536);
  const rgb = rgbPalette(layout.palette);
  // Screen code 1 is 'A' in the upper-case/graphics set and 'a' in the mixed-case one.
  for (let cell = 0; cell < 22 * 23; cell += 1) {
    mem[layout.charBase + cell] = cell % 22 === 0 ? 1 : 32;
    mem[layout.colorBase + cell] = 1; // white
  }
  // $900F: background light blue (14) in the high nibble, bit 3 normal video, border red (2).
  mem[0x900f] = (14 << 4) | 8 | 2;
  mem[0x9005] = 0xf0; // the boot set: upper case and graphics
  let frame = assertPaintParity(layout, mem);
  assert.deepEqual(framePixel(frame, 2, 2), rgb[2], 'the border is $900F bits 0-2');
  assert.deepEqual(framePixel(frame, BORDER_PX + 100, BORDER_PX + 100), rgb[14], 'the background is $900F bits 4-7');
  const upperInk = [0, 1, 2, 3, 4, 5, 6, 7].map((x) => framePixel(frame, BORDER_PX + x, BORDER_PX + 3)).filter((p) => p.join() === rgb[1].join()).length;
  // The border keeps only three bits: a value with bit 3 set is not a ninth colour.
  mem[0x900f] = (14 << 4) | 8 | 7 | 8;
  frame = assertPaintParity(layout, mem);
  assert.deepEqual(framePixel(frame, 2, 2), rgb[7], 'bit 3 is the normal-video bit, never part of the border');
  // $9005's low nibble 2 is the mixed-case block: 'A' becomes 'a' (a different row-3 pattern).
  mem[0x9005] = 0xf2;
  const lower = assertPaintParity(layout, mem);
  const sameAsUpper = [0, 1, 2, 3, 4, 5, 6, 7].map((x) => framePixel(lower, BORDER_PX + x, BORDER_PX + 3)).filter((p) => p.join() === rgb[1].join()).length;
  assert.notEqual(sameAsUpper, upperInk, "the mixed-case set draws code 1 differently from the upper-case one");
  // A CHARSET entry overrides the register from its line down: back to set 0 below picture line 16.
  storeEntry(mem, layout, 0, 16, Slot.CHARSET, 0);
  mem[layout.rasterCountOffset] = 1;
  mem[layout.rasterControlOffset] = 1;
  assertPaintParity(layout, mem);
  // Without the register block (a layout that names none) the old agreement bytes still rule.
  const plain = { ...layout, packedRegisters: null };
  mem[0] = 5;
  mem[1] = 6;
  frame = assertPaintParity(plain, mem);
  assert.deepEqual(framePixel(frame, 2, 2), rgb[5], 'no packed registers: the agreement byte is the border');
});

// A CHARSET band switches the loader to its ALT_GLYPHS table at the same
// line renderFrame switches glyphRows() to the alternate set.
test('the loader applies a CHARSET band, identically to renderFrame, on the default and PET skins', () => {
  for (const layout of [DEFAULT_LAYOUT, agreementFor({
    cols: 40, rows: 25, palette: PET_PALETTE, aspect: '4/3', colorPerCell: false, font: 'pet',
  })]) {
    const mem = new Uint8Array(65536);
    for (let cell = 0; cell < layout.cols * 6; cell += 1) {
      mem[layout.charBase + cell] = 97 + ((cell % layout.cols) % 26);
      mem[layout.colorBase + cell] = 1;
    }
    storeEntry(mem, layout, 0, 16, Slot.CHARSET, 1);
    storeEntry(mem, layout, 1, 36, Slot.CHARSET, 0);
    mem[layout.rasterCountOffset] = 2;
    mem[layout.rasterControlOffset] = 1;
    const frame = assertPaintParity(layout, mem);
    // Cell row 2 is inside the band and cell row 0 above it; both hold the
    // same letters, so they must draw differently — and row 5, below the
    // switch back at line 36, the same as row 0.
    const rowPixels = (cellRow) => {
      const out = [];
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 26 * 8; x += 1) out.push(...framePixel(frame, BORDER_PX + x, BORDER_PX + cellRow * 8 + y));
      }
      return out;
    };
    assert.notDeepEqual(rowPixels(2), rowPixels(0), 'the band draws the alternate set');
    assert.deepEqual(rowPixels(5), rowPixels(0), 'below the switch back, the boot set again');
  }
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

// The redefinable glyph table is the third thing the two compositors read from
// the program's memory (after the cells and the raster list), so a glyph the
// browser draws has to be the glyph --screenshot draws: the Modern host, the
// PET skin (no per-cell colour), under a CHARSET band and a SCROLL_X band,
// with defined and undefined codes and the table's first and last glyph.
for (const machine of ['hifi', 'pet-2001', 'vic20']) {
  test(`the loader paints redefined glyphs identically to renderFrame (${machine})`, () => {
    const facts = machine === 'hifi' ? {} : { 'video.columns': 40, 'video.rows': 25, 'video.colorPerCell': machine !== 'pet-2001' };
    const layout = layoutFromHardware({ facts, options: { machine } });
    assert.ok(layout.glyphBase > 0);
    const mem = new Uint8Array(65536);
    mem[0] = 6;
    mem[1] = 0;
    const define = (code, rows) => mem.set(rows, layout.glyphBase + (code - GLYPH_FIRST) * 8);
    define(GLYPH_FIRST, [0x81, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x81]);
    define(200, [0x0f, 0x0f, 0x0f, 0x0f, 0xf0, 0xf0, 0xf0, 0xf0]);
    define(255, [1, 2, 4, 8, 16, 32, 64, 128]);
    // cells: first, middle and last glyph, an undefined one, and a letter the
    // alternate set would remap, side by side on rows 0-3.
    const cells = [[0, GLYPH_FIRST, 7], [1, 200, 2], [2, 255, 5], [3, 201, 1], [4, 97, 1]];
    for (const [cell, code, color] of cells) {
      for (let row = 0; row < 4; row += 1) {
        mem[layout.charBase + row * layout.cols + cell] = code;
        mem[layout.colorBase + row * layout.cols + cell] = color;
      }
    }
    // CHARSET from line 8 to 24, SCROLL_X from line 16: the glyph rows are under both.
    storeEntry(mem, layout, 0, 8, Slot.CHARSET, 1);
    storeEntry(mem, layout, 1, 16, Slot.SCROLL_X, 3);
    storeEntry(mem, layout, 2, 24, Slot.CHARSET, 0);
    mem[layout.rasterCountOffset] = 3;
    mem[layout.rasterControlOffset] = 1;
    const mine = assertPaintParity(layout, mem);
    // And it is really painted: row 0 of the first glyph (0x81) lights its leftmost pixel.
    const palette = rgbPalette(layout.palette);
    assert.deepEqual(framePixel(mine, BORDER_PX, BORDER_PX), palette[machine === 'pet-2001' ? 1 : 7]);
  });
}

test('a host with no glyph table draws none in the loader either, whatever bytes sit where one would be', () => {
  const real = layoutForRealMachine('vic20', { facts: { 'video.columns': 22, 'video.rows': 23 }, tags: [] });
  assert.equal(real.glyphBase, -1);
  const mem = new Uint8Array(65536);
  mem[real.charBase] = 200;
  mem[real.colorBase] = 1;
  const where = real.rasterBase + RASTER_MAX_ENTRIES * RASTER_ENTRY_SIZE;
  mem.fill(0xff, where, where + GLYPH_BYTES);
  assertPaintParity(real, mem);
});
