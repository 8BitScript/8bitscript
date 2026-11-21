// graphics::hit and graphics::hitAny on the C64's own 6502 code, under x64sc. The program is the one
// packages/cli/test/graphics-hit.test.mjs runs as wasm (packages/cli/test/graphics-hit-cases.mjs);
// here it ends by drawing every answer byte on the text screen, one row of four bytes, one cell a bit
// (most significant first): a white cell is a 1, a red cell is a 0, and anything else fails. The
// header and the trailer are part of the picture, so a program that stopped early or a misread grid
// cannot pass. Skips without x64sc on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng } from '../../graphics-tools/src/index.mjs';
import { ART, LENGTH, PICTURES, expected, image, program } from '../../cli/test/graphics-hit-cases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');
const CHECKOUT = join(ROOT, '..', '..');

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}

function runCli(args, { timeoutMs = 180_000 } = {}) {
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

const PER_ROW = 4;
const STRIDE = 9; // eight bit cells and one empty one

// show(): every byte of `answers`, as reverse spaces coloured by bit.
const SHOW = [
  'fn show() {',
  '    text::setReverse(true);',
  '    let columns: usmallint = text::COLUMNS;',
  '    let mut rowStart: usmallint = 0;',
  '    let mut i: utinyint = 0;',
  `    while i < ${LENGTH} {`,
  '        let mut cell: usmallint = rowStart;',
  `        for j: utinyint in 0..${PER_ROW} {`,
  `            if i < ${LENGTH} {`,
  '                let mut v: utinyint = answers[i];',
  '                for bit: utinyint in 0..8 {',
  '                    text::putChar(cell, 32);',
  '                    if v >= 128 {',
  '                        text::putColor(cell, TextColor::WHITE);',
  '                    } else {',
  '                        text::putColor(cell, TextColor::RED);',
  '                    }',
  '                    v = v + v;',
  '                    cell = cell + 1;',
  '                }',
  '                cell = cell + 1;',
  '                i = i + 1;',
  '            }',
  '        }',
  '        rowStart = rowStart + columns;',
  '    }',
  '}',
];

// x64sc's NTSC screenshot is 384 x 247 and text cell (c, r) starts at (32 + 8c, 23 + 8r)
// (graphics-ops.test.mjs measures the same offset for stage pixels).
const WIDTH = 384;
const HEIGHT = 247;
const WHITE = [255, 255, 255];
const RED = [169, 71, 100];

function near([r, g, b], [pr, pg, pb]) {
  return Math.abs(r - pr) < 12 && Math.abs(g - pg) < 12 && Math.abs(b - pb) < 12;
}

function readBytes(file) {
  const { width, height, rgba } = decodePng(readFileSync(file));
  assert.deepEqual([width, height], [WIDTH, HEIGHT], 'x64sc\'s NTSC screenshot size');
  const bytes = [];
  for (let i = 0; i < LENGTH; i += 1) {
    const row = Math.floor(i / PER_ROW);
    const col = (i % PER_ROW) * STRIDE;
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const x0 = 32 + 8 * (col + bit);
      const y0 = 23 + 8 * row;
      let white = 0;
      let red = 0;
      for (let y = y0; y < y0 + 8; y += 1) {
        for (let x = x0; x < x0 + 8; x += 1) {
          const o = (y * WIDTH + x) * 4;
          const rgb = [rgba[o], rgba[o + 1], rgba[o + 2]];
          if (near(rgb, WHITE)) white += 1;
          else if (near(rgb, RED)) red += 1;
        }
      }
      assert.ok(white === 64 || red === 64, `byte ${i} bit ${7 - bit}: the cell is all white or all red (white ${white}, red ${red})`);
      value = value * 2 + (white === 64 ? 1 : 0);
    }
    bytes.push(value);
  }
  return bytes;
}

test('under x64sc, the C64 build stores the same answers as the wasm builds', { skip: onPath('x64sc') ? false : 'x64sc not on PATH' }, async () => {
  const dir = mkdtempSync(join(HERE, 'gfx-hit-'));
  try {
    for (const { name, w, h, opaque } of PICTURES) writeFileSync(join(dir, `${name}.png`), image(w, h, opaque));
    writeFileSync(join(dir, 'art.8bg'), ART);
    writeFileSync(join(dir, 'probe.8bs'), program({
      uses: ['use @8bitscript::screen::screen;', 'use @8bitscript::text::{text, TextColor};'],
      extra: SHOW,
      start: ['screen::blank();'],
      show: 'show();',
    }));
    const shot = join(dir, 'hit.png');
    const { code, stdout, stderr } = await runCli([
      'run', 'c64', '--checkout', CHECKOUT, '--screenshot', shot, '--frames', '600', join(dir, 'probe.8bs'),
    ]);
    assert.equal(code, 0, `8bs run c64 --screenshot failed:\n${stdout}${stderr}`);
    const got = readBytes(shot);
    const want = expected();
    assert.deepEqual(got, want, `first difference at byte ${got.findIndex((v, i) => v !== want[i])}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
