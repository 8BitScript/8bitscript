// @8bitscript/c64/charset for glyph codes of 32 and up, run for real under
// x64sc. test/charset-probe.8bs redefines glyphs 40, 200, 130 (a copy of 40)
// and 100 (one row) and puts each on row 0 of the screen beside the
// untouched glyph the old arithmetic wrote over (8, 8, 2, 4):
//
//   - `offset(code)` was `Video.CHARSET + code * 8` with a utinyint `code`,
//     an eight-bit product, so glyphs 32 and up were written 256 bytes low
//     (define(40) and define(200) both landed on glyph 8);
//   - the I/O window cleared CHAREN (%101 -> %001), where writes reach the
//     RAM but reads see the character ROM, so `copy` and `readRow` returned
//     the ROM's glyph instead of the program's own.
//
// The same two facts are pinned in the linked IR where CI runs them
// (packages/compiler/test/c64-charset-width.test.mjs).
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

test('the charset probe links clean for the C64', () => {
  const path = join(HERE, 'charset-probe.8bs');
  const { ir, diagnostics } = link(readFileSync(path, 'utf8'), path, { machine: 'c64', facts: stockFacts('c64') });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const fn of ['charset_define', 'charset_copy', 'charset_setRow', 'charset_readRow']) assert.ok(names.includes(fn), fn);
});

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

const isWhite = ([r, g, b]) => r > 200 && g > 200 && b > 200;
const isGreen = ([r, g, b]) => g > r + 30 && g > b + 30;

// x64sc's NTSC screenshot: text cell (row, column) starts at PNG pixel
// (32 + 8 * column, 23 + 8 * row), the border column at x = 4.
const cellRows = (png, cell) => Array.from({ length: 8 }, (_, row) => {
  let bits = '';
  for (let x = 0; x < 8; x++) bits += isWhite(pixelAt(png, 32 + cell * 8 + x, 23 + row)) ? '#' : '.';
  return bits;
});

test('under VICE, define/copy/setRow past glyph 31 change the glyph named, and leave its old neighbour alone', { skip: !onPath('x64sc') }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-charset-'));
  try {
    const shot = join(scratch, 'charset.png');
    const { code, stdout, stderr } = await runCli(['run', 'c64', '--screenshot', shot, 'test/charset-probe.8bs']);
    assert.equal(code, 0, `8bs run c64 --screenshot failed:\n${stdout}${stderr}`);
    const png = readFileSync(shot);

    // Cell 0: code 40, define()d solid. The ROM's glyph 40 is '('.
    assert.deepEqual(cellRows(png, 0), Array(8).fill('########'), 'define(40, ...) reached glyph 40');
    // Cell 1: code 200, define()d as the left four pixels.
    assert.deepEqual(cellRows(png, 1), Array(8).fill('####....'), 'define(200, ...) reached glyph 200');
    // Cell 2: code 130, copy(130, 40) of the solid glyph — the program's
    // own, not the ROM's '(' that a read through the old window returned.
    assert.deepEqual(cellRows(png, 2), Array(8).fill('########'), 'copy(130, 40) copied the glyph the program defined');
    // Cell 3: code 100, setRow(100, 0, 0xFF): row 0 solid, the rest the ROM's.
    const row100 = cellRows(png, 3);
    assert.equal(row100[0], '########', 'setRow(100, 0, ...) reached glyph 100 row 0');
    assert.deepEqual(row100.slice(1, 7), Array(6).fill('........'), "and left the ROM's other rows alone");
    // Cells 4-6: glyphs 8, 2 and 4 are 'H', 'B' and 'D', the glyphs the old
    // wrapped address wrote over (glyph 8 twice).
    assert.deepEqual(cellRows(png, 4), ['.##..##.', '.##..##.', '.##..##.', '.######.', '.##..##.', '.##..##.', '.##..##.', '........'], "glyph 8 is still the ROM's 'H'");
    assert.deepEqual(cellRows(png, 5), ['.#####..', '.##..##.', '.##..##.', '.#####..', '.##..##.', '.##..##.', '.#####..', '........'], "glyph 2 is still the ROM's 'B'");
    assert.deepEqual(cellRows(png, 6), ['.####...', '.##.##..', '.##..##.', '.##..##.', '.##..##.', '.##.##..', '.####...', '........'], "glyph 4 is still the ROM's 'D'");
    // The probe's own verdict: readRow gives back what was defined.
    assert.ok(isGreen(pixelAt(png, 4, 100)), `readRow reads the program's glyph (green border), got ${pixelAt(png, 4, 100)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
