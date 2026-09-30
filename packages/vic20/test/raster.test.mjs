// The VIC-20's raster list, run for real under xvic on both regions and
// read by pixel: test/raster-probe.8bs builds a list once, enable()s it,
// and keeps a frame loop running, and every split must land on its exact
// picture line, whole, on every frame — the target line entirely in the
// new colors and the line above entirely in the old, so nothing moves
// from frame to frame. Two consecutive frames per region, because the
// hook's edge poll lands with a different phase each frame and a split
// that is right on one frame can be a line out on the next.
//
// packages/vic20/AGENTS.md ("Raster splits") has the geometry these
// numbers come from: xvic's capture is 520 x 234 (NTSC) or 568 x 284
// (PAL), 8 pixels to a CPU cycle; raster line L is PNG row L - 28 on
// both; picture line 0 is raster line 50 (NTSC, $9001 = $19) or 76 (PAL,
// $26), so picture line P is row P + 22 or P + 48; the picture spans
// x 40-391 (NTSC) or 96-447 (PAL), the border the rest of the row.
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
const CHECKOUT = join(ROOT, '..', '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');
const PROBE = join(HERE, 'raster-probe.8bs');

test('the raster probe links clean for the VIC-20, with the frame hook and the plan builder in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, {
    machine: 'vic20', facts: stockFacts('vic20'), checkout: CHECKOUT,
  });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const fn of ['vic20RasterFrame', 'raster_commit', 'raster_setValue', 'raster_enable']) {
    assert.ok(names.some((name) => name === fn || name.endsWith(fn)), `${fn} in ${names.join(', ')}`);
  }
  assert.equal(stockFacts('vic20')['video.raster'], true, 'the catalog says the VIC-20 answers video.raster');
});

// --- Under VICE ---------------------------------------------------------

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}

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

async function shoot(scratch, name, extra) {
  const shot = join(scratch, `${name}.png`);
  const { code, stdout, stderr } = await runCli(['run', 'vic20', '--checkout', CHECKOUT, ...extra, '--screenshot', shot, 'test/raster-probe.8bs']);
  assert.equal(code, 0, `8bs run vic20 ${extra.join(' ')} --screenshot failed:\n${stdout}${stderr}`);
  return readFileSync(shot);
}

// VICE's VIC-20 palettes, by which channel dominates — the same colors on
// both regions, in different RGB (NTSC red 146,68,23, PAL 193,60,14).
const COLORS = {
  black: ([r, g, b]) => r < 40 && g < 40 && b < 40,
  red: ([r, g, b]) => r > g + 40 && r > b + 40,
  green: ([r, g, b]) => g > r + 30 && g >= b,
  yellow: ([r, g, b]) => r > 200 && g > 200 && b < 200,
};

const REGIONS = {
  ntsc: { flags: [], top: 22, picture: [40, 391] },
  pal: { flags: ['--pal'], top: 48, picture: [96, 447] },
};

/** Every pixel from x0 to x1 on `row` is `color`. */
function runIs(png, row, [x0, x1], color) {
  for (let x = x0; x <= x1; x++) {
    const pixel = pixelAt(png, x, row);
    if (!COLORS[color](pixel)) return `x ${x}: ${pixel}, not ${color}`;
  }
  return '';
}

// The probe's picture, by picture line: the border is black above 30, red
// 30-99, green 100-139, black from 140; the background yellow above 60,
// green 60-61 (built blue, setValue'd to green after fifty frames — the
// loop ran and the rewrite went live without a commit), red from 62 (the
// entry was written at 61, one line below 60's, and the two-line rule
// plans it at 62), yellow from 140 (two entries on one line, one pair of
// stores). The background's first band is read from line 8: the first
// text row, lines 0-7, holds the probe's frame counter.
const BORDER = [[0, 'black'], [30, 'red'], [100, 'green'], [140, 'black']];
const BACKGROUND = [[8, 'yellow'], [60, 'green'], [62, 'red'], [140, 'yellow']];

for (const [region, geometry] of Object.entries(REGIONS)) {
  test(`under VICE (${region}), every split lands on its picture line, whole, on consecutive frames`, { skip: !onPath('xvic') && 'xvic is not on PATH' }, async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-vic20-raster-'));
    try {
      for (const frames of [822, 823]) {
        const png = await shoot(scratch, `${region}-${frames}`, [...geometry.flags, '--frames', String(frames)]);
        const width = png.readUInt32BE(16);
        const row = (line) => geometry.top + line;
        const [left, right] = geometry.picture;
        const label = `${region}, --frames ${frames}`;

        // Each band, down the border column and across the picture.
        const bands = (list, check) => list.forEach(([line, color], i) => {
          const last = i + 1 < list.length ? list[i + 1][0] - 1 : 183;
          for (const at of [line, last]) check(at, color);
        });
        // (The left border only: a border split's store lands inside the
        // picture of the line above it, so that line's RIGHT border is
        // already the next color — a one-line step at the right edge, the
        // one place a border split shows off its own line; AGENTS.md says
        // why no store position avoids it.)
        bands(BORDER, (line, color) => {
          assert.ok(COLORS[color](pixelAt(png, 5, row(line))), `${label}: border at picture line ${line} is ${color}, got ${pixelAt(png, 5, row(line))}`);
        });
        bands(BACKGROUND, (line, color) => {
          assert.equal(runIs(png, row(line), [left, right], color), '', `${label}: background across picture line ${line}`);
        });

        // Whole lines: at every background split the line above is entirely
        // the old color and the target line entirely the new — a store
        // that landed inside the picture would split one of them.
        for (let i = 1; i < BACKGROUND.length; i++) {
          const [line, color] = BACKGROUND[i];
          const before = BACKGROUND[i - 1][1];
          assert.equal(runIs(png, row(line - 1), [left, right], before), '', `${label}: the line above ${line} is all ${before}`);
          assert.equal(runIs(png, row(line), [left, right], color), '', `${label}: picture line ${line} is all ${color}`);
        }
        // And every border split is whole on its line, left border and right.
        for (let i = 1; i < BORDER.length; i++) {
          const [line, color] = BORDER[i];
          assert.equal(runIs(png, row(line), [0, left - 1], color), '', `${label}: left border of picture line ${line}`);
          assert.equal(runIs(png, row(line), [right + 1, width - 1], color), '', `${label}: right border of picture line ${line}`);
          assert.equal(runIs(png, row(line - 1), [0, left - 1], BORDER[i - 1][1]), '', `${label}: left border of the line above ${line}`);
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
