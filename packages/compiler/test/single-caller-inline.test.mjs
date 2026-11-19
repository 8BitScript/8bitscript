// The zero-cost gate for rule 9 (a function with one live call site is
// written into it) and for sizing a body after its own callees are in
// it, both measured on the machine with the least to spare. 2048 #51
// split drawTile() into paintTile() + stampValue() + a Tile element and
// paid +56 bytes on every 6502 and +84 on the PET 2001 — three real
// calls with frames where one body was meant; 2048 #52 saw a
// parameterless Board, small as written, pasted into main three times
// carrying the whole inlined ScoreBar, +393 bytes on the PET.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from '../src/mos/index.ts';
import { build as buildWasm } from '../src/wasm/index.ts';
import { optimizeReachable } from '../src/linker/optimize.mjs';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';
import { linkFiles } from './support/link-files.mjs';

const petHardware = () => {
  const resolved = resolveHardware(loadCatalog('pet'), {});
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  return resolved.hardware;
};

/** Link `files` from `entry` and build the PET image; the bytes of the program, and the size report. */
async function petBuild(files, entry) {
  const { ir, diagnostics } = linkFiles(files, entry, { bx: { strict: false } });
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [], entry);
  const dir = mkdtempSync(join(tmpdir(), '8bs-single-'));
  try {
    const result = await build(ir, { machine: 'pet', hardware: petHardware(), outFile: join(dir, 'out.prg'), frameRate: 60, report: true });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    // The size report names an inlined body after its origin, so "is it
    // still a function" is the optimizer's answer, not the report's.
    const functions = optimizeReachable(ir).functions.map((fn) => fn.name);
    return { bytes: [...result.bytes], report: result.sizeReport ?? [], memory: result.memory, functions };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function wasmBuild(files, entry) {
  const { ir, diagnostics } = linkFiles(files, entry, { machine: 'web', bx: { strict: false } });
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [], entry);
  const dir = mkdtempSync(join(tmpdir(), '8bs-single-wasm-'));
  try {
    const result = await buildWasm(ir, { outFile: join(dir, 'out.wasm'), frameRate: 60, report: true });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    const functions = optimizeReachable(ir).functions.map((fn) => fn.name);
    return { bytes: [...result.bytes], report: result.sizeReport ?? [], functions };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the tile, one body vs. three -------------------------------------------
//
// The shape 2048 #51 measured: a square of reverse-video cells with the
// value's digits centred on the middle row. Run-time row, column and
// exponent, real 16-bit cell arithmetic, two calls into a text package
// that stays a package (two sites each, so neither rule inlines it).

const TEXT = `pub let mut colour: utinyint = 0;
pub let mut reverse: bool = false;
pub mod text {
    fn setColor(c: utinyint) {
        colour = c;
    }
    fn setReverse(on: bool) {
        reverse = on;
    }
    fn fill(cell: usmallint, count: usmallint, code: utinyint) {
        let mut i: usmallint = 0;
        while i < count {
            memory::write(0x8000 + cell + i, code);
            i = i + 1;
        }
        return;
    }
    fn printNumber(cell: usmallint, value: usmallint, width: utinyint) {
        let mut at: usmallint = cell;
        let mut w: utinyint = width;
        while w > 0 {
            memory::write(0x8000 + at, 48 + (value & 7));
            value = value >> 3;
            at = at + 1;
            w = w - 1;
        }
        return;
    }
}
`;

const TABLES = `pub const POW2: [usmallint; 12] = [0, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
pub const TILE_COLOR: [utinyint; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4];
pub const TILE_DIGITS: [utinyint; 12] = [1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4];
pub let mut cellWidth: usmallint = 5;
pub let mut tileH: utinyint = 3;
pub let mut boardTop: usmallint = 2;
pub let mut leftMargin: usmallint = 4;
pub fn tileCell(row: utinyint, col: utinyint) -> usmallint {
    let y: usmallint = boardTop + row * (tileH + 1);
    let x: usmallint = leftMargin + col * (cellWidth + 1);
    return y * 40 + x;
}
`;

// One body: the hand-written drawTile 2048 shipped for a year.
const ONE_BODY = `use self::text::text;
use self::tables::{POW2, TILE_COLOR, TILE_DIGITS, cellWidth, tileH, tileCell};
pub fn drawTile(row: utinyint, col: utinyint, exponent: utinyint) {
    let origin: usmallint = tileCell(row, col);
    let value: usmallint = POW2[exponent];
    text::setColor(TILE_COLOR[exponent]);
    text::setReverse(true);
    let mut rowCell: usmallint = origin;
    let mut numRow: usmallint = origin;
    let mid: utinyint = tileH >> 1;
    let mut line: utinyint = 0;
    while line < tileH {
        text::fill(rowCell, cellWidth, 32);
        if line == mid {
            numRow = rowCell;
        }
        rowCell = rowCell + 40;
        line += 1;
    }
    if value != 0 {
        let width: utinyint = TILE_DIGITS[exponent];
        let offset: utinyint = cellWidth - width >> 1;
        text::printNumber(numRow + offset, value, width);
    }
    text::setReverse(false);
}
`;

// Three bodies: the square and the digits as lib primitives, the element
// calling both — #51's rejected form, as written there.
const PRIMITIVES = `use self::text::text;
use self::tables::{POW2, TILE_COLOR, TILE_DIGITS, cellWidth, tileH};
pub fn paintTile(origin: usmallint, exponent: utinyint) -> usmallint {
    text::setColor(TILE_COLOR[exponent]);
    text::setReverse(true);
    let mut rowCell: usmallint = origin;
    let mut numRow: usmallint = origin;
    let mid: utinyint = tileH >> 1;
    let mut line: utinyint = 0;
    while line < tileH {
        text::fill(rowCell, cellWidth, 32);
        if line == mid {
            numRow = rowCell;
        }
        rowCell = rowCell + 40;
        line += 1;
    }
    return numRow;
}
pub fn stampValue(at: usmallint, exponent: utinyint) {
    let value: usmallint = POW2[exponent];
    if value != 0 {
        let width: utinyint = TILE_DIGITS[exponent];
        let offset: utinyint = cellWidth - width >> 1;
        text::printNumber(at + offset, value, width);
    }
    text::setReverse(false);
}
`;

const TILE_ELEMENT = `use self::tables::tileCell;
use self::draw::{paintTile, stampValue};
pub component Tile(row: utinyint, col: utinyint, exponent: utinyint) {
    let origin: usmallint = tileCell(row, col);
    let numRow: usmallint = paintTile(origin, exponent);
    stampValue(numRow, exponent);
}
`;

// The program: sixteen tiles from a board, and one more with a run-time
// exponent from elsewhere, so nothing about the arguments folds.
const PROGRAM = (draw, element) => `use self::text::text;
${draw};
let board: [utinyint; 16];
let extra: utinyint = 0;
pub fn main() {
    for i: utinyint in 0..16 {
        ${element ? '<Tile row={i >> 2} col={i & 3} exponent={board[i]} />;' : 'drawTile(i >> 2, i & 3, board[i]);'};
    }
    text::setColor(extra);
    text::printNumber(0, 0, 2);
    text::fill(0, 4, 32);
}
`;

test('a tile split into two lib primitives and an element costs what the one-body function cost — 2048 #51\'s +56/+84 is 0', async () => {
  const oneBody = await petBuild({
    'text.8bs': TEXT, 'tables.8bs': TABLES, 'draw.8bs': ONE_BODY,
    'main.8bs': PROGRAM('use self::draw::drawTile;', false),
  }, 'main.8bs');
  const split = await petBuild({
    'text.8bs': TEXT, 'tables.8bs': TABLES, 'draw.8bs': PRIMITIVES, 'Tile.8bx': TILE_ELEMENT,
    'main.8bx': PROGRAM('use self::Tile::Tile;', true),
  }, 'main.8bx');
  assert.ok(!split.functions.includes('paintTile') && !split.functions.includes('stampValue'), 'the primitives are written into the element, their one caller each');
  assert.ok(split.bytes.length <= oneBody.bytes.length, `split ${split.bytes.length} > one body ${oneBody.bytes.length}`);
  // The same instructions at the same size; the locals are allotted zero
  // page in a different order (the callee's after the element's own), so
  // the bytes themselves differ, as they do between any two layouts.
  assert.equal(split.bytes.length, oneBody.bytes.length, 'the same program at the same size');
  assert.equal(split.memory.variables, oneBody.memory.variables, 'and the same RAM');
});

test('the same split builds to the same wasm as the one body — the rule is the optimizer\'s, not one backend\'s', async () => {
  const oneBody = await wasmBuild({
    'text.8bs': TEXT, 'tables.8bs': TABLES, 'draw.8bs': ONE_BODY,
    'main.8bs': PROGRAM('use self::draw::drawTile;', false),
  }, 'main.8bs');
  const split = await wasmBuild({
    'text.8bs': TEXT, 'tables.8bs': TABLES, 'draw.8bs': PRIMITIVES, 'Tile.8bx': TILE_ELEMENT,
    'main.8bx': PROGRAM('use self::Tile::Tile;', true),
  }, 'main.8bx');
  assert.ok(!split.functions.includes('paintTile') && !split.functions.includes('stampValue'), 'the primitives are written into the element on the web too');
  assert.ok(split.bytes.length <= oneBody.bytes.length, `split ${split.bytes.length} > one body ${oneBody.bytes.length}`);
});

// ---- sizing after inlining ---------------------------------------------------
//
// 2048 #52: a parameterless Board reading its globals was under the
// duplicate-size limit as written, so main took three copies — each
// carrying the ScoreBar that had been inlined into Board. Measured on
// the callee's finished body, Board is a function, as the version that
// passes the HUD's values as props already was.

const HUD = `pub let mut score: usmallint = 0;
pub let mut over: bool = false;
pub let mut won: bool = false;
pub fn scoreBar(s: usmallint, o: bool, w: bool) {
    memory::write(0x8000, s);
    memory::write(0x8001, s >> 8);
    if o {
        memory::write(0x8002, 1);
        memory::write(0x8003, 2);
        memory::write(0x8004, 3);
    }
    if w {
        memory::write(0x8005, 4);
        memory::write(0x8006, 5);
        memory::write(0x8007, 6);
    }
    memory::write(0x8008, 7);
    memory::write(0x8009, 8);
}
`;

const GAME = (board) => `use self::hud::{score, over, won};
${board};
let mut moved: bool = false;
pub fn main() {
    <Board />;
    loop {
        score = score + 2;
        if score > 100 {
            over = true;
        }
        if score > 50 {
            won = true;
        }
        if moved {
            <Board />;
        }
        if over {
            <Board />;
            moved = false;
        }
    }
}
`;

test('a parameterless composition is sized with its callees in it: three sites take three calls, not three copies — 2048 #52\'s +393 is 0', async () => {
  const withProps = await petBuild({
    'hud.8bs': HUD,
    'main.8bx': GAME(`use self::hud::scoreBar;
component ScoreBar(s: usmallint, o: bool, w: bool) {
    scoreBar(s, o, w);
}
component Board() {
    <ScoreBar s={score} o={over} w={won} />;
}`),
  }, 'main.8bx');
  const withoutProps = await petBuild({
    'hud.8bs': HUD,
    'main.8bx': GAME(`use self::hud::scoreBar;
component ScoreBar() {
    scoreBar(score, over, won);
}
component Board() {
    <ScoreBar />;
}`),
  }, 'main.8bx');
  // Board's whole body is `<ScoreBar />`, so rule 8 puts ScoreBar at
  // Board's three sites; ScoreBar, sized with scoreBar() already in it, is
  // one function called three times — not three copies in main.
  assert.ok(withoutProps.functions.includes('ScoreBar'), 'the composition is one function, called three times');
  assert.ok(!withoutProps.functions.includes('Board'), 'and the wrapper around it is gone');
  assert.ok(withoutProps.bytes.length <= withProps.bytes.length, `reading the globals in place ${withoutProps.bytes.length} > passing them ${withProps.bytes.length}`);
});

// ---- what stays a call --------------------------------------------------------

test('a void helper ending in `return;` keeps its one caller\'s call — the idiom 2048\'s game.8bs relies on', async () => {
  const program = (helper) => ({
    'main.8bs': `let mut cursor: utinyint = 0;
fn helper(n: utinyint) {
    memory::write(0x8000 + cursor, n);
    memory::write(0x8001 + cursor, n + 1);
    cursor = cursor + 2;
    ${helper};
}
pub fn main() {
    helper(cursor);
}
`,
  });
  const kept = await petBuild(program('return;'), 'main.8bs');
  const inlined = await petBuild(program(''), 'main.8bs');
  assert.ok(kept.functions.includes('helper'), 'with the return, a real function');
  assert.ok(!inlined.functions.includes('helper'), 'without it, written into main');
  assert.ok(inlined.bytes.length < kept.bytes.length, 'and smaller for it');
});
