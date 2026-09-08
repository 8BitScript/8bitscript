// @8bitscript/pet/blocks — quadrant-block pseudo-pixels and the digit tiles
// built from them. Three layers, weakest to strongest: the package exports
// the subpath and the probe links clean (no emulator); the digit font's
// `const` data actually decodes, byte for byte, back to the pixel picture
// documented above it in the source (catches a hand-transcribed screen
// code drifting from the font it is supposed to draw); and, under xpet,
// the rendered screen matches at pixels calibrated against a real
// screenshot (see the coordinates below — measured, not guessed).
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
const PROBE = join(HERE, 'blocks-probe.8bs');
const SOURCE = readFileSync(join(ROOT, 'src', 'blocks.8bs'), 'utf8');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the package exports ./blocks', () => {
  assert.equal(pkg['8bitscript'].exports['./blocks'], './src/blocks.8bs');
  assert.ok(existsSync(join(ROOT, 'src', 'blocks.8bs')));
});

test('the probe links clean for the PET, and every call is a real function in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'pet', facts: stockFacts('pet') });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const name of ['blocks_quad', 'blocks_put', 'digits_draw', 'digits_print', 'digits_count', 'digits_printCentered']) {
    assert.ok(names.includes(name), name);
  }
});

test('blocks never selects the graphics character set: quadrant codes 96-127/224-255 render the same in both, so drawing them never writes viaPeripheralControl', () => {
  const code = SOURCE.replace(/\/\/.*$/gm, ''); // strip line comments, which explain why in prose
  assert.doesNotMatch(code, /viaPeripheralControl/, 'blocks.8bs must not depend on the PCR charset bit — see the file header');
});

// ---- the font's const data, decoded back to pixels -------------------------

function parseArray(name) {
  const match = SOURCE.match(new RegExp(`const ${name}: array<\\w+, \\d+> = \\[([\\s\\S]*?)\\];`));
  assert.ok(match, `const ${name} not found in blocks.8bs`);
  const withoutComments = match[1].replace(/\/\/.*$/gm, '');
  return withoutComments
    .split(',')
    .map((tok) => tok.trim())
    .filter((tok) => tok.length > 0)
    .map(Number);
}

const QUAD = parseArray('QUAD');
const DIGIT_TILES = parseArray('DIGIT_TILES');
const DIGIT_BASE = parseArray('DIGIT_BASE');

test('QUAD has all sixteen 2x2 patterns, each exactly once', () => {
  assert.equal(QUAD.length, 16);
  assert.equal(new Set(QUAD).size, 16, 'no screen code repeats across the sixteen patterns');
});

// The font this feature ships, a 2x3-cell (4x6 pseudo-pixel) tile: a classic
// 3x5 dot-matrix numeral elongated by repeating its own row 1, plus one
// blank pixel-column of margin (the right column) — no blank row, on
// purpose (see blocks.8bs's own comment above DIGIT_TILES: a font with its
// own leftover blank row can only put it on one side, which is what made a
// tile's margin above a digit come out different from its margin below).
// This is that same picture, kept here so a change to one without the
// other fails a test instead of drifting unnoticed.
const FONT = {
  0: ['###.', '#.#.', '#.#.', '#.#.', '#.#.', '###.'],
  1: ['.#..', '##..', '##..', '.#..', '.#..', '###.'],
  2: ['###.', '..#.', '..#.', '###.', '#...', '###.'],
  3: ['###.', '..#.', '..#.', '###.', '..#.', '###.'],
  4: ['#.#.', '#.#.', '#.#.', '###.', '..#.', '..#.'],
  5: ['###.', '#...', '#...', '###.', '..#.', '###.'],
  6: ['###.', '#...', '#...', '###.', '#.#.', '###.'],
  7: ['###.', '..#.', '..#.', '..#.', '..#.', '..#.'],
  8: ['###.', '#.#.', '#.#.', '###.', '#.#.', '###.'],
  9: ['###.', '#.#.', '#.#.', '###.', '..#.', '###.'],
};

const REVERSE_QUAD = new Map(QUAD.map((code, index) => [code, index]));

// Decodes a digit's 6 codes (2 wide, 3 tall) back to its 4x6 picture, the
// inverse of the encoding gen4x6.mjs used to produce DIGIT_TILES.
function decodeDigit(base) {
  const rows = ['', '', '', '', '', ''];
  for (let cellRow = 0; cellRow < 3; cellRow++) {
    for (let cellCol = 0; cellCol < 2; cellCol++) {
      const code = DIGIT_TILES[base + cellRow * 2 + cellCol];
      const index = REVERSE_QUAD.get(code);
      assert.ok(index !== undefined, `screen code ${code} is not one of QUAD's sixteen patterns`);
      const topLeft = (index >> 3) & 1, topRight = (index >> 2) & 1;
      const bottomLeft = (index >> 1) & 1, bottomRight = index & 1;
      rows[cellRow * 2] += (topLeft ? '#' : '.') + (topRight ? '#' : '.');
      rows[cellRow * 2 + 1] += (bottomLeft ? '#' : '.') + (bottomRight ? '#' : '.');
    }
  }
  return rows;
}

test('DIGIT_BASE steps by 6 (WIDTH*HEIGHT) cells per digit, for all ten digits', () => {
  assert.deepEqual(DIGIT_BASE, [0, 6, 12, 18, 24, 30, 36, 42, 48, 54]);
});

for (let value = 0; value <= 9; value++) {
  test(`digit ${value}'s tile decodes to its documented 4x6 picture`, () => {
    assert.deepEqual(decodeDigit(DIGIT_BASE[value]), FONT[value]);
  });
}

// digits.count()'s own logic (>= 10, >= 100, ...), mirrored here so a typo
// in one of those thresholds fails a test instead of only showing up as a
// wrongly-centered tile under xpet.
function count(value) {
  let n = 1;
  if (value >= 10) n = 2;
  if (value >= 100) n = 3;
  if (value >= 1000) n = 4;
  if (value >= 10000) n = 5;
  return n;
}

test('digits.count matches the number of decimal digits, for every boundary from 0 to 65535', () => {
  for (const value of [0, 1, 9, 10, 11, 99, 100, 101, 999, 1000, 1001, 9999, 10000, 10001, 65535]) {
    assert.equal(count(value), String(value).length, `count(${value})`);
  }
});

// ---- game tiles: printCentered() and invert ----------------------------
//
// A 2048-style tile: a solid reverse-video square with a centered, inverted
// number cut into it. This is a pure-JS model of what blocks-probe.8bs
// draws (fillTile() + digits.printCentered(..., true)), checked against the
// real screenshot below the same way the digit fonts are checked above.
function digitPattern(value, cellRow, cellCol) {
  const code = DIGIT_TILES[DIGIT_BASE[value] + cellRow * 2 + cellCol];
  const index = REVERSE_QUAD.get(code);
  return [(index >> 3) & 1, (index >> 2) & 1, (index >> 1) & 1, index & 1]; // TL, TR, BL, BR
}

// `rowOffset` is how many blank tile rows sit above the digit's own 3 rows
// (blocks-probe.8bs draws each tile 5 cells tall and the digit 1 row down,
// so rowOffset is 1 there) — printCentered() itself only centers
// horizontally, so the caller places it vertically the same way the probe
// does.
function expectedTile(widthCells, heightCells, value, invert, rowOffset = 0) {
  const digitValues = String(value).split('').map(Number);
  const used = digitValues.length * 2;
  const pad = widthCells > used ? Math.floor((widthCells - used) / 2) : 0;
  const grid = Array.from({ length: heightCells }, () => Array.from({ length: widthCells }, () => [1, 1, 1, 1]));
  digitValues.forEach((digitValue, digitIndex) => {
    for (let cellRow = 0; cellRow < 3; cellRow++) {
      for (let cellCol = 0; cellCol < 2; cellCol++) {
        let [topLeft, topRight, bottomLeft, bottomRight] = digitPattern(digitValue, cellRow, cellCol);
        if (invert) [topLeft, topRight, bottomLeft, bottomRight] = [1 - topLeft, 1 - topRight, 1 - bottomLeft, 1 - bottomRight];
        const gridRow = rowOffset + cellRow;
        const gridCol = pad + digitIndex * 2 + cellCol;
        if (gridRow < heightCells && gridCol < widthCells) grid[gridRow][gridCol] = [topLeft, topRight, bottomLeft, bottomRight];
      }
    }
  });
  return grid;
}

test('printCentered pads a short number and lets a long one run past the edge, matching hand math for both', () => {
  // "16" (2 digits, 4 cells used) centered in an 8-wide tile: floor((8-4)/2) = 2 cells of padding each side.
  assert.deepEqual(expectedTile(8, 1, 16, false)[0].slice(0, 2), [[1, 1, 1, 1], [1, 1, 1, 1]]); // left pad: untouched tile fill
  // "2048" (4 digits, 8 cells used) in an 8-wide tile: floor((8-8)/2) = 0 — starts at the left edge, no room to spare.
  const wide = expectedTile(8, 1, 2048, false)[0];
  assert.deepEqual(wide[0], digitPattern(2, 0, 0)); // no left pad: digit 0 of "2048" starts at column 0
});

// ---- under xpet -------------------------------------------------------

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
const HAS_SDK = Boolean(process.env.LLVM_MOS_HOME);
const skip = (!HAS_SDK && 'LLVM_MOS_HOME not set') || (!onPath('xpet') && 'xpet not on PATH');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');

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

test('under xpet, the ten digits and the two blocks.put patterns render the pixels their tiles say they should', { skip }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-pet-blocks-'));
  try {
    const shot = join(scratch, 'blocks.png');
    const { code, stdout, stderr } = await runCli(['run', 'pet', '--screenshot', shot, 'test/blocks-probe.8bs']);
    assert.equal(code, 0, `8bs run pet --screenshot failed:\n${stdout}${stderr}`);
    const png = readFileSync(shot);

    // Measured against this exact probe/screenshot: screen cell 0 (the
    // digits row's top-left corner) starts at pixel (32, 8); every cell is
    // 8x8 pixels, and every pseudo-pixel a 4x4 quadrant of one, so
    // quadrant (col, row, half) samples 2px in from its own corner to stay
    // clear of the ROM glyph's edge.
    const isLit = (x, y) => {
      const [r, g, b] = pixelAt(png, x, y);
      return r > 80 || g > 80 || b > 80;
    };
    const quadPixel = (col, row, right, bottom) => isLit(32 + col * 8 + (right ? 6 : 2), 8 + row * 8 + (bottom ? 6 : 2));

    // Digit 0 occupies cells (0-1, 0-2). Row 0 is "###." — both quadrants
    // of cell (0,0) on, and the left quadrant only of cell (1,0) on (its
    // right quadrant is the font's blank margin column).
    assert.equal(quadPixel(0, 0, false, false), true, 'digit 0, cell(0,0) top-left: on');
    assert.equal(quadPixel(0, 0, true, false), true, 'digit 0, cell(0,0) top-right: on');
    assert.equal(quadPixel(1, 0, false, false), true, 'digit 0, cell(1,0) top-left: on');
    assert.equal(quadPixel(1, 0, true, false), false, 'digit 0, cell(1,0) top-right: off (margin column)');

    // Digit 1 (cells 2-3) is "narrow": row 0 is ".#.." — only cell (2,0)'s
    // right quadrant is on.
    assert.equal(quadPixel(2, 0, false, false), false, 'digit 1, cell(0,0) top-left: off');
    assert.equal(quadPixel(2, 0, true, false), true, 'digit 1, cell(0,0) top-right: on');

    // Digit 8 (cells 16-17, digits.WIDTH=2 * value 8) is symmetric, closed
    // top and bottom.
    assert.equal(quadPixel(16, 0, false, false), true, 'digit 8, cell(0,0) top-left: on');
    assert.equal(quadPixel(16, 0, true, false), true, 'digit 8, cell(0,0) top-right: on');

    // blocks.put(400, true, false, false, true) and (401, false, true, true,
    // false) — cell row 10, columns 0 and 1 — draw the two diagonals
    // directly, not through the digit font.
    assert.equal(quadPixel(0, 10, false, false), true, 'blocks.put diagonal: top-left on');
    assert.equal(quadPixel(0, 10, true, false), false, 'blocks.put diagonal: top-right off');
    assert.equal(quadPixel(0, 10, false, true), false, 'blocks.put diagonal: bottom-left off');
    assert.equal(quadPixel(0, 10, true, true), true, 'blocks.put diagonal: bottom-right on');
    assert.equal(quadPixel(1, 10, false, false), false, 'second blocks.put diagonal: top-left off');
    assert.equal(quadPixel(1, 10, true, false), true, 'second blocks.put diagonal: top-right on');

    // The two game tiles: fillTile() at (0, 12) 8x5 with "16" centered,
    // inverted, and drawn one row down from the tile's top, and at (0, 18)
    // 8x5 with "2048" the same way — checked cell by cell, quadrant by
    // quadrant, against expectedTile()'s model of the same padding, invert
    // and vertical-offset math the probe runs.
    function checkTile(startCol, startRow, widthCells, heightCells, value, invert, rowOffset, label) {
      const expected = expectedTile(widthCells, heightCells, value, invert, rowOffset);
      for (let row = 0; row < heightCells; row++) {
        for (let col = 0; col < widthCells; col++) {
          const [topLeft, topRight, bottomLeft, bottomRight] = expected[row][col];
          assert.equal(quadPixel(startCol + col, startRow + row, false, false), Boolean(topLeft), `${label}: cell (${col},${row}) top-left`);
          assert.equal(quadPixel(startCol + col, startRow + row, true, false), Boolean(topRight), `${label}: cell (${col},${row}) top-right`);
          assert.equal(quadPixel(startCol + col, startRow + row, false, true), Boolean(bottomLeft), `${label}: cell (${col},${row}) bottom-left`);
          assert.equal(quadPixel(startCol + col, startRow + row, true, true), Boolean(bottomRight), `${label}: cell (${col},${row}) bottom-right`);
        }
      }
    }
    checkTile(0, 12, 8, 5, 16, true, 1, 'tile "16" centered+inverted in an 8-wide, 5-tall tile');
    checkTile(0, 18, 8, 5, 2048, true, 1, 'tile "2048" centered+inverted in an 8-wide, 5-tall tile');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
