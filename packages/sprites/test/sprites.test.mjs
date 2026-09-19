// @8bitscript/sprites — one program, nine machines, three mechanisms.
// Three layers, weakest to strongest: the manifest names the portable
// entry and its C64 and PET twins; the probes link clean for all nine
// targets with the right twin's functions in the IR and the one surface
// (names, parameter types, return types); and under VICE the same probe
// renders twenty-two hardware sprites on the C64 (two of them in the
// opened border), eight quadrant-block sprites on the PET (and a walk
// through two standing ones restores the text under all three, pixel for
// pixel) and sixteen cell glyphs on the VIC-20, at pixels calibrated
// against real screenshots (the coordinates below are measured, not
// guessed — 2026-09-19).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';
import { pixelAt } from '../../cli/src/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const MACHINES = ['c64', 'vic20', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];

test('the manifest names the portable cell layer as the entry, with the C64 and PET twins beside it', () => {
  assert.equal(pkg['8bitscript'].entry, './src/index.8bs');
  assert.ok(existsSync(join(ROOT, 'src', 'index.8bs')));
  assert.ok(existsSync(join(ROOT, 'src', 'index.c64.8bs')), 'the C64 resolves index.c64.8bs on its own (chooseVariant)');
  assert.ok(existsSync(join(ROOT, 'src', 'index.pet.8bs')), 'the PET resolves index.pet.8bs the same way');
  for (const dep of ['@8bitscript/c64', '@8bitscript/system', '@8bitscript/text']) {
    assert.equal(pkg.dependencies[dep], 'workspace:*', dep);
  }
});

// The surface every twin has to offer — by name, parameter types and
// return type, since a program written against one must link against
// the others and `y` is sixteen bits everywhere (the X16's 56 rows were
// out of a byte's reach). `portable-contract.test.mjs` reads entry maps
// and never sees a file twin, so this is where the twins are held to it.
const SURFACE = {
  sprites_begin: [['utinyint'], 'void'],
  sprites_place: [['utinyint', 'usmallint', 'usmallint'], 'void'],
  sprites_setShape: [['utinyint', 'utinyint'], 'void'],
  sprites_setColor: [['utinyint', 'utinyint'], 'void'],
  sprites_hide: [['utinyint'], 'void'],
  sprites_setBackground: [['utinyint'], 'void'],
  sprites_extend: [['bool'], 'void'],
  sprites_dropped: [[], 'utinyint'],
  sprites_plan: [[], 'utinyint'],
  sprites_update: [[], 'utinyint'],
  sprites_left: [[], 'usmallint'],
  sprites_right: [[], 'usmallint'],
  sprites_top: [[], 'usmallint'],
  sprites_bottom: [[], 'usmallint'],
};
const TWIN = { c64: 'sprite', pet: 'quadrant', };

for (const machine of MACHINES) {
  test(`the sprites probe links clean for ${machine}, through the ${TWIN[machine] ?? 'cell'} twin, to the one surface`, () => {
    const path = join(HERE, 'sprites-probe.8bs');
    const { ir, diagnostics } = link(readFileSync(path, 'utf8'), path, { machine, facts: stockFacts(machine) });
    assert.deepEqual(diagnostics, []);
    const names = ir.functions.map((f) => f.name);
    for (const [fn, [params, returns]] of Object.entries(SURFACE)) {
      const f = ir.functions.find((g) => g.name === fn);
      assert.ok(f, `${machine}: ${fn}`);
      assert.deepEqual(f.params.map((p) => p.type), params, `${machine}: ${fn}'s parameters`);
      assert.equal(f.returnType, returns, `${machine}: ${fn} returns`);
    }
    if (machine === 'c64') {
      for (const fn of ['multiplex_update', 'border_bottom', 'raster_commit', 'raster_enable', 'shapes_begin']) assert.ok(names.includes(fn), fn);
      assert.ok(!names.includes('cellAt'), 'no cell math on the C64');
    } else if (machine === 'pet') {
      for (const fn of ['sprites_defineShape', 'draw', 'restore']) assert.ok(names.includes(fn), `pet: ${fn}, the quadrant twin`);
      assert.ok(!names.includes('text_putChar'), 'pet: the quadrant twin writes the screen itself');
    } else {
      assert.ok(names.includes('cellAt'), `${machine}: the cell layer`);
      assert.ok(!names.some((n) => /multiplex|border|raster/.test(n)), `${machine}: nothing of the C64 layer`);
    }
  });
}

test('the cells probe links clean for every machine', () => {
  const path = join(HERE, 'cells-probe.8bs');
  for (const machine of MACHINES) {
    const { diagnostics } = link(readFileSync(path, 'utf8'), path, { machine, facts: stockFacts(machine) });
    assert.deepEqual(diagnostics, [], machine);
  }
});

test('the measurement probes — the PET crossing and timing, the C64 timing — link clean for their machines', () => {
  for (const [name, machine] of [['pet-overlap.8bs', 'pet'], ['pet-timing.8bs', 'pet'], ['c64-timing.8bs', 'c64']]) {
    const path = join(HERE, name);
    const { diagnostics } = link(readFileSync(path, 'utf8'), path, { machine, facts: stockFacts(machine) });
    assert.deepEqual(diagnostics, [], name);
  }
});

// --- Under VICE ---------------------------------------------------------

function runCli(args, { timeoutMs = 120_000 } = {}) {
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

async function shoot(scratch, machine, extra = [], probe = 'test/sprites-probe.8bs') {
  const shot = join(scratch, `${machine}.png`);
  const { code, stdout, stderr } = await runCli(['run', machine, ...extra, '--screenshot', shot, probe]);
  assert.equal(code, 0, `8bs run ${machine} --screenshot failed:\n${stdout}${stderr}`);
  const size = stdout.match(/(\d+) bytes of program/);
  assert.ok(size, `size line in:\n${stdout}`);
  return { png: readFileSync(shot), bytes: Number(size[1]) };
}

// VICE's palette, by which channel dominates.
const isWhite = ([r, g, b]) => r > 200 && g > 200 && b > 200;
const isYellow = ([r, g, b]) => r > 200 && g > 200 && b < 200;
const isCyan = ([r, g, b]) => g > 180 && b > 180 && r < 180;
const isGreen = ([r, g, b]) => g > r + 40 && g > b + 40;
const isDark = ([r, g, b]) => r < 60 && g < 60 && b < 60;
const isLit = ([r, g, b]) => r + g + b > 150;
const COLOR_OF = [isWhite, isYellow, isCyan, isGreen]; // COLORS[v & 3] in the probe: 1, 7, 3, 5

// The probe's end state (32 frames of drift): sprite v = 5r + c at stage
// (72 + 60c, 60 + 40r) on the C64 (ORIGIN 24, 50), (48 + 60c, 10 + 40r)
// on a cell machine (ORIGIN 0, 0) — cell (6 + 7c-ish: 6, 13, 21, 28, 36;
// row 1 + 5r). Actor 20 at stage (174, 28) is in the C64's top border,
// 21 at (174, 240) in its bottom one.
test('under x64sc, all twenty-two sprites are sprites at their positions, two of them in the opened border, whole to their last row', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-sprites-c64-'));
  try {
    const { png } = await shoot(scratch, 'c64', ['--frames', '500']);
    // This VICE's NTSC picture: PNG row = raster line - 28, PNG column =
    // sprite X + 8 (packages/c64/AGENTS.md). A sprite at Y draws lines
    // Y + 1 .. Y + 21; sample its centre.
    const at = (x, y) => pixelAt(png, x + 8 + 12, y + 1 - 28 + 10);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 5; c++) {
        const v = 5 * r + c;
        assert.ok(COLOR_OF[v & 3](at(72 + 60 * c, 60 + 40 * r)), `sprite ${v} at its colour`);
      }
    }
    assert.ok(isWhite(at(174, 28)), 'sprite 20, above the playfield: the top border is open');
    assert.ok(isYellow(at(174, 240)), 'sprite 21, below the playfield: the bottom border is open');
    // Its last three rows (lines 259-261) are still at its own X. They
    // were not, when the handler wrote the frame table at line 255: the
    // reused sprite jumped to its next frame's X (312 & 255 = 56) there.
    for (const line of [259, 260, 261]) {
      assert.ok(isYellow(pixelAt(png, 174 + 8 + 12, line - 28)), `sprite 21 at line ${line}: its own X`);
      assert.ok(isDark(pixelAt(png, 56 + 8 + 12, line - 28)), `nothing at X 56 on line ${line}`);
    }
    assert.ok(isDark(at(72 + 30, 60)), 'the gap between sprites is background');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// Measured: PET cell (0, 0) at PNG (32, 8), 8 x 8 (as
// packages/pet/test/blocks.test.mjs); VIC-20 cell (0, 0) at PNG (42, 22),
// 16 x 8 — xvic doubles pixels across.
const CELL_GRIDS = {
  pet: { x0: 32, y0: 8, cw: 8, columns: 40 },
  vic20: { x0: 42, y0: 22, cw: 16, columns: 22 },
};

function cellReaders(png, grid) {
  const lit = (x, y) => isLit(pixelAt(png, x, y));
  const centre = (col, row) => lit(grid.x0 + col * grid.cw + grid.cw / 2, grid.y0 + row * 8 + 3);
  const cellLit = (col, row) => {
    for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < grid.cw; dx++) if (lit(grid.x0 + col * grid.cw + dx, grid.y0 + row * 8 + dy)) return true;
    return false;
  };
  const cellSolid = (col, row) => {
    for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < grid.cw; dx++) if (!lit(grid.x0 + col * grid.cw + dx, grid.y0 + row * 8 + dy)) return false;
    return true;
  };
  return { lit, centre, cellLit, cellSolid };
}

// The cell twin holds sixteen: the probe's begin(22) degrades to 16 and
// place(20)/place(21) are ignored, so rows 0-2 show whole, row 3 shows its
// first sprite (15) only, and the two border sprites do not exist.
const COLS = [6, 13, 21, 28, 36]; // (48 + 60c) >> 3
const ROWS = [1, 6, 11, 16];      // (10 + 40r) >> 3

test('under xvic, sixteen sprites are asterisks at their cells, past-MAX sprites ignored, nothing else on the grid', async () => {
  const grid = CELL_GRIDS.vic20;
  const scratch = await mkdtemp(join(tmpdir(), '8bs-sprites-vic20-'));
  try {
    const { png, bytes } = await shoot(scratch, 'vic20');
    // The whole probe, program bytes: 1185 on the VIC-20 as of 2026-09-19,
    // against 3583 of RAM. The layer itself is ~500 of that.
    assert.ok(bytes < 2000, `vic20: ${bytes} bytes — the cell layer has grown; its budget is the unexpanded VIC-20`);
    const { centre, cellLit } = cellReaders(png, grid);
    // An asterisk lights the middle of its cell and not its corner; a
    // blank cell lights nothing.
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 5; c++) {
        const v = 5 * r + c;
        if (COLS[c] >= grid.columns) continue; // clipped past the grid's right edge: outside the picture
        const expected = v < 16;
        assert.equal(centre(COLS[c], ROWS[r]), expected, `vic20: sprite ${v} at cell (${COLS[c]}, ${ROWS[r]}) ${expected ? 'drawn' : 'past MAX: not drawn'}`);
      }
    }
    assert.equal(cellLit(18, 3), false, 'vic20: sprite 20 (past MAX) is not drawn');
    // A row between the sprite rows, and the row above the first, is untouched.
    for (const col of COLS) if (col < grid.columns) {
      assert.equal(cellLit(col, 0), false, `vic20: row 0, column ${col} is blank`);
      assert.equal(cellLit(col, 3), false, `vic20: row 3, column ${col} is blank`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// The PET twin holds eight quadrant sprites of 4 x 4 pseudo-pixels: the
// probe's begin(22) degrades to 8, its ASCII setShape() is ignored (shape
// 0, a solid block, stays), and sprite v = 5r + c lands with its top-left
// pseudo-pixel at ((48 + 60c) >> 2, (10 + 40r) >> 2) — cell (6 + 7.5c,
// 1 + 5r): the even columns aligned to a cell (two solid cells across),
// the odd ones straddling (three cells, the outer two half lit).
test('under xpet, eight sprites are quadrant blocks at their pseudo-pixels, straddling cells where they must, past-MAX sprites ignored', async () => {
  const grid = CELL_GRIDS.pet;
  const scratch = await mkdtemp(join(tmpdir(), '8bs-sprites-pet-'));
  try {
    const { png, bytes } = await shoot(scratch, 'pet');
    // The whole probe: 2662 bytes on the PET as of 2026-09-19, against the
    // stock 2001's 3071 — the twin's tables (252 of shape patterns, 72 of
    // save-under) are most of the difference from the cell layer.
    assert.ok(bytes < 3071, `pet: ${bytes} bytes — the quadrant twin no longer fits the stock 2001`);
    const { cellLit, cellSolid } = cellReaders(png, grid);
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 5; c++) {
        const v = 5 * r + c;
        const row = ROWS[r];
        if (v < 8) {
          if (c % 2 === 0) {
            // aligned: cells (col, col + 1) x (row, row + 1) solid, nothing beside
            for (const dr of [0, 1]) for (const dc of [0, 1]) assert.ok(cellSolid(COLS[c] + dc, row + dr), `pet: sprite ${v} cell (${COLS[c] + dc}, ${row + dr}) solid`);
            assert.equal(cellLit(COLS[c] + 2, row), false, `pet: nothing right of sprite ${v}`);
          } else {
            // straddling: the middle column solid, the two edge columns half lit
            for (const dr of [0, 1]) {
              assert.ok(cellSolid(COLS[c] + 1, row + dr), `pet: sprite ${v} middle cell (${COLS[c] + 1}, ${row + dr}) solid`);
              assert.ok(cellLit(COLS[c], row + dr) && !cellSolid(COLS[c], row + dr), `pet: sprite ${v} left edge half lit`);
              assert.ok(cellLit(COLS[c] + 2, row + dr) && !cellSolid(COLS[c] + 2, row + dr), `pet: sprite ${v} right edge half lit`);
            }
          }
        } else {
          assert.equal(cellLit(COLS[c], row), false, `pet: sprite ${v} past MAX: not drawn`);
        }
      }
    }
    for (const r of [2, 3]) for (const col of COLS) assert.equal(cellLit(col, ROWS[r]), false, `pet: row ${ROWS[r]}, column ${col}: sprites 10-19 are past MAX`);
    assert.equal(cellLit(18, 3), false, 'pet: sprite 20 (past MAX) is not drawn');
    for (const col of COLS) {
      assert.equal(cellLit(col, 0), false, `pet: row 0, column ${col} is blank`);
      assert.equal(cellLit(col, 3), false, `pet: row 3, column ${col} is blank`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// test/pet-overlap.8bs: two sprites standing over a row of text, a third
// walking through both and hiding. Row 13 carries the same text and is
// never walked on; after the walk rows 10 and 11 must equal it pixel for
// pixel outside the standers' cells (10-12), and row 12 — the straddling
// stander's third row, the mover's path — must be blank outside them.
test('under xpet, a sprite walking through two standing sprites over text leaves the text and the standers exactly as they were', async () => {
  const grid = CELL_GRIDS.pet;
  const scratch = await mkdtemp(join(tmpdir(), '8bs-sprites-pet-overlap-'));
  try {
    const { png } = await shoot(scratch, 'pet', [], 'test/pet-overlap.8bs');
    const { lit, cellLit } = cellReaders(png, grid);
    let differing = 0;
    for (const row of [10, 11]) {
      for (let col = 0; col < 40; col++) {
        if (col >= 10 && col <= 12) continue;
        for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) {
          if (lit(grid.x0 + col * 8 + dx, grid.y0 + row * 8 + dy) !== lit(grid.x0 + col * 8 + dx, grid.y0 + 13 * 8 + dy)) differing++;
        }
      }
    }
    assert.equal(differing, 0, 'the text under the walk is restored pixel for pixel');
    for (let col = 0; col < 40; col++) if (col < 10 || col > 12) assert.equal(cellLit(col, 12), false, `row 12, column ${col}: nothing of the mover left`);
    assert.ok(cellLit(13, 10), 'the text right of the standers is there'); // sanity: the reference is text, not blank
    for (const dr of [0, 1, 2]) for (const dc of [0, 1, 2]) assert.ok(cellLit(10 + dc, 10 + dr), `the standers' cell (${10 + dc}, ${10 + dr}) is drawn`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
