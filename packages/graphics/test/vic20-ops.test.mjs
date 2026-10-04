// The VIC-20 twin's operations — place, hide, setFrame, animate, color,
// update — run for real and read cell by cell.
//
// packages/vic20/test/graphics-ops.test.mjs shows them under xvic, but the
// machine packages' tests are not part of the CI gate (scripts/ci-excluded-
// packages.mjs) and need an emulator. This is the same code, run where CI
// can: the twin (index.vic20.8bs) is imported into a program built for the
// web target, whose wasm the repository can execute in node, and the program
// copies the VIC-20's screen and color RAM — which the twin writes with
// `memory.write` at the addresses the geometry file names — into a
// snapshot area after each step. What a test reads is exactly what the twin
// stored, in the cells the VIC would draw from, on both memory maps.
//
// A test that can only pass is no test, so each behaviour is also run
// against a copy of the twin with that behaviour broken, and must fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from '../../cli/src/build.mjs';
import { instantiateProgram } from '../../cli/src/wasm-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, '..', '..');
const TWIN = readFileSync(join(PACKAGES, 'graphics', 'src', 'index.vic20.8bs'), 'utf8');
const require = createRequire(import.meta.url);

const LAYOUTS = {
  unexpanded: { geometry: join(PACKAGES, 'vic20', 'src', 'geometry.8bs'), screen: 0x1e00, color: 0x9600 },
  '8k': { geometry: join(PACKAGES, 'vic20', 'src', 'geometry.vic20.expanded.8bs'), screen: 0x1000, color: 0x9400 },
};
const COLUMNS = 22;
const ROWS = 23;
const CELLS = COLUMNS * ROWS;
const SNAP = 0xa000; // snapshot k lives at SNAP + k * 0x400: 506 screen bytes, then 506 color
const SPACE = 32;
const WHITE = 1;

// ---- running the twin --------------------------------------------------------

/** Build `body` (the statements of main) against `twin` and run it; the memory afterwards. */
async function execute(body, { layout = 'unexpanded', twin = TWIN } = {}) {
  const where = LAYOUTS[layout];
  const dir = await mkdtemp(join(tmpdir(), '8bs-v20-ops-'));
  const prev = process.cwd();
  const log = console.log;
  try {
    // The twin names its geometry by package; a copy in a scratch directory
    // names it by path, which is also how the 8K map is chosen.
    await writeFile(join(dir, 'twin.8bs'), twin.replace('@8bitscript/vic20/geometry', where.geometry));
    const source = `import { graphics } from "./twin.8bs";
import { Video } from ${JSON.stringify(where.geometry)};

function snap(base: usmallint): void {
    for (let i: usmallint = 0; i < ${CELLS}; i++) {
        memory.write(base + i, memory.read(Video.SCREEN + i));
        memory.write(base + ${CELLS} + i, memory.read(Video.COLOR + i));
    }
}

// The 4K where the web build keeps the twin's own tables (about $2100), a
// copy of it to compare; above both screens ($1E00 + 506, $1000 + 506).
function keep(base: usmallint): void {
    for (let i: usmallint = 0; i < 4096; i++) {
        memory.write(base + i, memory.read(0x2000 + i));
    }
}

export function main(): void {
${body}
}
`;
    const entry = join(dir, 'main.8bs');
    await writeFile(entry, source);
    process.chdir(dir);
    console.log = () => {};
    const result = await compile('web', entry);
    console.log = log;
    assert.equal(result.ok, true, JSON.stringify(result));
    const program = await instantiateProgram(await readFile(result.outFile));
    program.entry();
    return new Uint8Array(program.memory.buffer).slice();
  } finally {
    console.log = log;
    process.chdir(prev);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Snapshot `k`, as `cell(col, row)` -> [screen code, color RAM]. */
function snapshot(memory, k) {
  const base = SNAP + k * 0x400;
  return {
    cell: (col, row) => [memory[base + row * COLUMNS + col], memory[base + CELLS + row * COLUMNS + col]],
    all: () => Array.from(memory.slice(base, base + 2 * CELLS)),
  };
}

/** `calls(0, ...)` as lines of main. */
const snap = (k) => `    snap(${SNAP + k * 0x400});`;

/** The binder calls the compiler writes for a sprite: its codes, then its size and speed. */
function picture(slot, frames, every, width, height, codes) {
  const bind = codes.map((code, i) => `    graphics.bind(${slot}, ${i}, ${code});`).join('\n');
  return `${bind}\n    graphics.meta(${slot}, ${frames}, ${every}, 4, ${width}, ${height});`;
}

/** Every cell of the snapshot is untouched (0, 0) except those in `expected`, a map of "col,row" -> [code, color]. */
function assertCells(view, expected, label) {
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLUMNS; col++) {
      const want = expected[`${col},${row}`] ?? [0, 0];
      assert.deepEqual(view.cell(col, row), want, `${label}: cell (${col}, ${row})`);
    }
  }
}

/** A 2x2 object's cells at (col, row), as expected-map entries. */
function block(col, row, codes, ink) {
  return {
    [`${col},${row}`]: [codes[0], ink],
    [`${col + 1},${row}`]: [codes[1], ink],
    [`${col},${row + 1}`]: [codes[2], ink],
    [`${col + 1},${row + 1}`]: [codes[3], ink],
  };
}

/** Where a cell the object has left stands: blank, in the default ink. */
function blanked(col, row) {
  return block(col, row, [SPACE, SPACE, SPACE, SPACE], WHITE);
}

const A = [108, 123, 98, 124];
const B = [97, 126, 127, 160];
const F0 = [101, 102, 103, 104];
const F1 = [111, 112, 113, 114];
const G0 = [121, 122, 123, 124];
const G1 = [131, 132, 133, 134];

// ---- the scenarios, each a body and a check on its snapshots -------------------
//
// A scenario is a function of the twin's source, so the same check can be
// pointed at a copy of the twin with something broken (see "the checks bite").

const scenarios = {
  // hide blanks the object's cells, color RAM back to the default ink; hiding
  // twice, or a hidden one at update(), changes nothing; place shows it again
  async hide(twin, layout) {
    const memory = await execute(`${picture(0, 1, 4, 16, 16, A)}
    graphics.color(0, 3);
    graphics.place(0, 8, 8);
    graphics.update();
${snap(0)}
    graphics.hide(0);
    graphics.update();
${snap(1)}
    graphics.hide(0);
    graphics.update();
    graphics.update();
${snap(2)}
    graphics.place(0, 88, 120);
${snap(3)}
    graphics.hide(0);
    graphics.place(0, 8, 8);
    graphics.update();
${snap(4)}`, { twin, layout });
    assertCells(snapshot(memory, 0), block(1, 1, A, 3), 'placed, in its ink');
    assertCells(snapshot(memory, 1), blanked(1, 1), 'hidden: cells blanked, color RAM back to white, not left in its ink');
    assert.deepEqual(snapshot(memory, 2).all(), snapshot(memory, 1).all(), 'hiding again, and updating while hidden, change nothing');
    assertCells(snapshot(memory, 3), { ...blanked(1, 1), ...block(11, 15, A, 3) }, 'placed again elsewhere, still in its ink');
    assertCells(snapshot(memory, 4), { ...blanked(11, 15), ...block(1, 1, A, 3) }, 'hidden and placed in one go');
  },

  // setFrame shows from the next update(), clamps, and a held frame holds
  // while another object keeps animating; animate(true) picks up from there
  async frames(twin, layout) {
    const memory = await execute(`${picture(0, 2, 4, 16, 16, [...F0, ...F1])}
${picture(1, 2, 4, 16, 16, [...G0, ...G1])}
    graphics.place(0, 8, 8);
    graphics.place(1, 88, 8);
    graphics.update();
    graphics.update();
    graphics.update();
${snap(0)}
    graphics.update();
${snap(1)}
    graphics.animate(0, false);
    graphics.update();
    graphics.update();
    graphics.update();
    graphics.update();
    graphics.update();
    graphics.update();
${snap(2)}
    graphics.setFrame(0, 0);
${snap(3)}
    graphics.update();
    graphics.update();
    graphics.update();
    graphics.update();
    graphics.update();
${snap(4)}
    graphics.setFrame(0, 9);
    graphics.update();
${snap(5)}
    graphics.animate(0, true);
    graphics.update();
    graphics.update();
    graphics.update();
    graphics.update();
${snap(6)}`, { twin, layout });
    assertCells(snapshot(memory, 0), { ...block(1, 1, F0, WHITE), ...block(11, 1, G0, WHITE) }, '3 updates, every 4: still frame 0');
    assertCells(snapshot(memory, 1), { ...block(1, 1, F1, WHITE), ...block(11, 1, G1, WHITE) }, '4 updates: frame 1');
    assertCells(snapshot(memory, 2), { ...block(1, 1, F1, WHITE), ...block(11, 1, G0, WHITE) }, 'object 0 held on frame 1 while object 1 went on to frame 0');
    assertCells(snapshot(memory, 3), { ...block(1, 1, F1, WHITE), ...block(11, 1, G0, WHITE) }, 'setFrame shows from the next update, not at once');
    assertCells(snapshot(memory, 4), { ...block(1, 1, F0, WHITE), ...block(11, 1, G1, WHITE) }, 'setFrame(0, 0): frame 0, and held there while object 1 played on');
    assertCells(snapshot(memory, 5), { ...block(1, 1, F1, WHITE), ...block(11, 1, G0, WHITE) }, 'a frame past the last is the last (object 1 wrapped to its first)');
    assertCells(snapshot(memory, 6), { ...block(1, 1, F0, WHITE), ...block(11, 1, G1, WHITE) }, 'animate(true): stepping resumes from the frame it was on, after `every` updates');
  },

  // color sets the ink of the object's cells only, takes the first eight
  // colors (bit 3 of color RAM would make a cell multicolor), and what a move
  // leaves behind is not in the object's ink
  async color(twin, layout) {
    const memory = await execute(`${picture(0, 1, 4, 16, 16, A)}
${picture(1, 1, 4, 16, 16, B)}
    graphics.place(0, 8, 8);
    graphics.place(1, 88, 88);
    graphics.update();
${snap(0)}
    graphics.color(0, 2);
${snap(1)}
    graphics.update();
${snap(2)}
    graphics.color(0, 9);
    graphics.color(1, 15);
    graphics.update();
${snap(3)}
    graphics.color(0, 5);
    graphics.update();
    graphics.place(0, 8, 120);
    graphics.update();
${snap(4)}
    graphics.hide(0);
    graphics.update();
${snap(5)}`, { twin, layout });
    assertCells(snapshot(memory, 0), { ...block(1, 1, A, WHITE), ...block(11, 11, B, WHITE) }, 'default ink: white');
    assertCells(snapshot(memory, 1), { ...block(1, 1, A, WHITE), ...block(11, 11, B, WHITE) }, 'color() shows from the next update');
    assertCells(snapshot(memory, 2), { ...block(1, 1, A, 2), ...block(11, 11, B, WHITE) }, 'color(0, 2): that object red, the other still white');
    assertCells(snapshot(memory, 3), { ...block(1, 1, A, 1), ...block(11, 11, B, 7) }, '9 wraps to 1 and 15 to 7: never bit 3');
    assertCells(snapshot(memory, 4), { ...blanked(1, 1), ...block(1, 15, A, 5), ...block(11, 11, B, 7) }, 'moved: the cells it left are blank and white, not green');
    assertCells(snapshot(memory, 5), { ...blanked(1, 1), ...blanked(1, 15), ...block(11, 11, B, 7) }, 'hidden: likewise');
  },

  // the 64-byte pool: the last byte is usable, an object that would pass it is
  // not drawn, every call on it does nothing, and the others are not harmed
  async pool(twin, layout) {
    const eight = (codes) => [...codes, ...codes, ...codes, ...codes, ...codes, ...codes, ...codes, ...codes];
    const memory = await execute(`${picture(0, 8, 4, 16, 16, eight(A))}
${picture(1, 8, 4, 16, 16, eight(B))}
${picture(2, 1, 4, 16, 16, A)}
    graphics.place(0, 8, 8);
    graphics.place(1, 64, 8);
    graphics.place(2, 120, 8);
    graphics.update();
${snap(0)}
    graphics.setFrame(2, 3);
    graphics.color(2, 2);
    graphics.animate(2, false);
    graphics.animate(2, true);
    graphics.hide(2);
    graphics.place(2, 120, 8);
    graphics.update();
    graphics.update();
${snap(1)}`, { twin, layout });
    const both = { ...block(1, 1, A, WHITE), ...block(8, 1, B, WHITE) };
    assertCells(snapshot(memory, 0), both, '32 + 32 bytes fill the pool exactly; the third object (4 more) is not drawn');
    assert.deepEqual(snapshot(memory, 1).all(), snapshot(memory, 0).all(), 'every call on the object that did not fit did nothing');
    // one byte over, from a one-cell object
    return execute(`${picture(0, 8, 4, 16, 16, eight(A))}
${picture(1, 32, 4, 8, 8, Array.from({ length: 32 }, (_, i) => 101 + (i % 4)))}
${picture(2, 1, 4, 8, 8, [108])}
    graphics.place(0, 8, 8);
    graphics.place(1, 88, 8);
    graphics.place(2, 120, 8);
    graphics.update();
${snap(0)}`, { twin, layout }).then((over) => {
      assertCells(snapshot(over, 0), { ...block(1, 1, A, WHITE), '11,1': [101, WHITE] }, '32 + 32 fit; a 1-cell, 1-byte third object does not');
    });
  },

  // positions: rounded down to a cell, off the playfield not drawn, the
  // right and bottom edges clipped, nothing written past the screen
  async clip(twin, layout) {
    const memory = await execute(`${picture(0, 1, 4, 16, 16, A)}
${picture(1, 1, 4, 16, 16, B)}
${picture(2, 1, 4, 16, 16, F0)}
${picture(3, 1, 4, 16, 16, G0)}
    graphics.place(0, 83, 45);
    graphics.place(1, 336, 8);
    graphics.place(2, 8, 400);
    graphics.place(3, 168, 176);
    graphics.update();
${snap(0)}`, { twin, layout });
    assertCells(snapshot(memory, 0), { ...block(10, 5, A, WHITE), '21,22': [G0[0], WHITE] }, 'rounded down to a cell; off the playfield not drawn; the corner object keeps only its first cell');
    const where = LAYOUTS[layout];
    for (const base of [where.screen, where.color]) {
      assert.deepEqual(Array.from(memory.slice(base + CELLS, base + CELLS + 32)), new Array(32).fill(0), `nothing written past the last cell (${base.toString(16)} + ${CELLS})`);
    }
  },

  // overlapping objects come out the same whichever moved: the later slot is on top
  async overlap(twin, layout) {
    const memory = await execute(`${picture(0, 1, 4, 16, 16, A)}
${picture(1, 1, 4, 16, 16, B)}
    graphics.place(0, 8, 8);
    graphics.place(1, 16, 16);
    graphics.update();
${snap(0)}
    graphics.place(0, 8, 8);
    graphics.update();
${snap(1)}
    graphics.hide(1);
    graphics.update();
${snap(2)}`, { twin, layout });
    const stacked = { ...block(1, 1, A, WHITE), ...block(2, 2, B, WHITE) };
    assertCells(snapshot(memory, 0), stacked, 'object 1 on top of object 0');
    assertCells(snapshot(memory, 1), stacked, 're-placing the lower one does not bring it to the front');
    assertCells(snapshot(memory, 2), { ...block(1, 1, A, WHITE), ...blanked(2, 2), '2,2': [A[3], WHITE] }, 'hiding the top one shows the one under it again');
  },

  // a slot past MAX does nothing at all — nothing drawn, and none of the
  // twin's own tables touched (an index past an array lands in the next one)
  // — and an object never placed is never drawn
  async bounds(twin, layout) {
    const memory = await execute(`${picture(0, 2, 4, 16, 16, [...F0, ...F1])}
    keep(0xB000);
    graphics.place(8, 8, 8);
    graphics.place(200, 8, 8);
    graphics.hide(8);
    graphics.hide(255);
    graphics.setFrame(9, 1);
    graphics.animate(10, false);
    graphics.color(11, 2);
    graphics.color(255, 2);
    graphics.update();
    graphics.update();
    keep(0xC000);
${snap(0)}`, { twin, layout });
    assertCells(snapshot(memory, 0), {}, 'slots past MAX and an object never placed: nothing drawn');
    const before = Array.from(memory.slice(0xb000, 0xc000));
    assert.ok(before.some((byte) => byte !== 0), 'the copy of low memory caught the twin\'s tables (they are in it)');
    assert.deepEqual(Array.from(memory.slice(0xc000, 0xd000)), before, 'the twin\'s own tables are as they were');
  },
};

for (const layout of Object.keys(LAYOUTS)) {
  for (const [name, scenario] of Object.entries(scenarios)) {
    test(`VIC-20 twin (${layout}): ${name}`, async () => {
      await scenario(TWIN, layout);
    });
  }
}

// ---- the checks bite ------------------------------------------------------------

/** `TWIN` with `from` replaced by `to`; a broken twin the check must catch. */
function broken(from, to) {
  assert.ok(TWIN.includes(from), `the mutation target is still in the twin: ${from}`);
  return TWIN.replace(from, to);
}

const MUTATIONS = [
  ['color() stores the color unmasked', 'ink[slot] = c & 0x07;', 'ink[slot] = c;', 'color'],
  ['blanking leaves the color RAM alone', '                    memory.write(Video.COLOR + cell, INK); // not left in the ink it was drawn in\n', '', 'color'],
  ['blanking leaves the color RAM alone (hide)', '                    memory.write(Video.COLOR + cell, INK); // not left in the ink it was drawn in\n', '', 'hide'],
  ['the pool takes one byte too many', 'if (end > POOL) {', 'if (end > POOL + 1) {', 'pool'],
  ['the pool is one byte short', 'if (end > POOL) {', 'if (end >= POOL) {', 'pool'],
  ['clipping is gone', 'if (c < Video.COLUMNS && r < Video.ROWS) {', 'if (true) {', 'clip'],
  ['setFrame does not clamp', '            n = frames[slot] - 1;', '            n = n;', 'frames'],
  ['animate(false) does not pause', '    function animate(slot: utinyint, on: bool): void {\n        if (slot >= SLOTS) {\n            return;\n        }\n        paused[slot] = 1;', '    function animate(slot: utinyint, on: bool): void {\n        if (slot >= SLOTS) {\n            return;\n        }\n        paused[slot] = 0;', 'frames'],
  ['hide forgets to blank', '        seen[slot] = 0;\n        moved[slot] = 1;', '        seen[slot] = 0;', 'hide'],
  ['slots past MAX are not refused', '    function place(slot: utinyint, x: usmallint, y: usmallint): void {\n        if (slot >= SLOTS) {\n            return;\n        }', '    function place(slot: utinyint, x: usmallint, y: usmallint): void {', 'bounds'],
];

for (const [what, from, to, name] of MUTATIONS) {
  test(`the ${name} check fails when ${what}`, async () => {
    const twin = broken(from, to);
    await assert.rejects(() => scenarios[name](twin, 'unexpanded'), `${what}: the ${name} check must notice`);
  });
}

// ---- the 6502 builds it ------------------------------------------------------------
//
// The wasm run above is the twin's logic; this is the twin through the real
// VIC-20 backend, unexpanded and with 8K (where the screen and the program
// move), with every operation reached so none is pruned: it must build, fit
// the machine, and not grow without somebody noticing.

/** Bytes of program the all-operations probe may take: 1710 measured on 2026-10-04, on both layouts, with a little room. */
const BUDGET = 1800;

for (const layout of Object.keys(LAYOUTS)) {
  test(`the 6502 build of the twin links every operation and fits the VIC-20 (${layout})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), '8bs-v20-build-'));
    const prev = process.cwd();
    const log = console.log;
    try {
      const entry = join(dir, 'main.8bs');
      await writeFile(entry, `import { graphics } from "@8bitscript/graphics";
export function main(): void {
    graphics.bind(0, 0, 108);
    graphics.bind(0, 1, 123);
    graphics.bind(0, 2, 98);
    graphics.bind(0, 3, 124);
    graphics.meta(0, 1, 4, 4, 16, 16);
    graphics.place(0, 8, 8);
    graphics.setFrame(0, 1);
    graphics.animate(0, false);
    graphics.color(0, 2);
    graphics.hide(0);
    while (true) {
        waitFrame();
        graphics.update();
    }
}
`);
      process.chdir(dir);
      console.log = () => {};
      const result = await compile('vic20', entry, { checkout: join(PACKAGES, '..'), hardware: layout === '8k' ? { ram: '8k' } : {} });
      console.log = log;
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.ok(result.memory.program > 0 && result.memory.program <= BUDGET, `${layout}: ${result.memory.program} bytes of program, budget ${BUDGET}`);
      assert.ok(result.memory.program + result.memory.variables < (layout === '8k' ? 11775 : 3583), `${layout}: fits the machine's RAM`);
    } finally {
      console.log = log;
      process.chdir(prev);
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// ---- the lowering and the twin agree ---------------------------------------------

test('the media module and the twin state the same pool size, and a sprite says how much of it it takes', () => {
  const media = require('../../vic20/media/index.cjs');
  const pool = Number(/^const POOL: utinyint = (\d+);/m.exec(TWIN)?.[1]);
  const message = (frames, width) => {
    const rgba = new Uint8Array(width * width * 4);
    for (let i = 0; i < width * width; i += 1) rgba.set([0, 0, 0, 255], i * 4);
    const sprite = { name: 'x', start: 0, length: 1, animations: [{ name: 'go', frames: frames.map((_, i) => i), every: 2 }] };
    const result = media.lowerGraphics(sprite, frames.map(() => ({ rgba, width, height: width })), {}, 'a.8bg', (code, text) => ({ code, message: text }));
    return result.diagnostics.map((d) => d.message).join(' | ');
  };
  assert.equal(pool, 64);
  assert.match(message([0, 1, 2], 16), new RegExp(`taking 12 of the ${pool} pool bytes every object shares`), '3 frames of 2x2 cells: 12 bytes');
  assert.match(message([0], 8), new RegExp(`taking 1 of the ${pool} pool bytes`), 'one cell: 1 byte');
  assert.match(message([0], 8), /one that does not fit is not drawn/);
});
