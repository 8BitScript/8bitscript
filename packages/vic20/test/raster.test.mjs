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
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';
import { pixelAt } from '../../cli/src/png.mjs';
import { decode, lit, onPath, runCli } from './capture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHECKOUT = join(ROOT, '..', '..');
const PROBE = join(HERE, 'raster-probe.8bs');
const CHARSET_PROBE = join(HERE, 'raster-charset-probe.8bs');

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


async function shoot(scratch, name, extra, probe = 'test/raster-probe.8bs') {
  const shot = join(scratch, `${name}.png`);
  const { code, stdout, stderr } = await runCli(['run', 'vic20', '--checkout', CHECKOUT, ...extra, '--screenshot', shot, probe]);
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

// --- Slot.CHARSET ------------------------------------------------------
//
// test/raster-charset-probe.8bs fills every cell with screen code 66,
// whose glyph differs on all eight lines between the upper-case/graphics
// ROM set and the mixed-case one, and splits the picture eight times
// mid-row. Two reference captures — the whole screen held in each set —
// give every picture line's pixels in both; each line of the probe must
// match exactly the set its entries say, on every line from 0 to 183
// (so a split one line early or late, or a line torn between the sets,
// fails), on two consecutive frames per region.

test('the CHARSET probe links clean for the VIC-20', () => {
  const { ir, diagnostics } = link(readFileSync(CHARSET_PROBE, 'utf8'), CHARSET_PROBE, {
    machine: 'vic20', facts: stockFacts('vic20'), checkout: CHECKOUT,
  });
  assert.deepEqual(diagnostics, []);
  assert.ok(ir.functions.some((f) => f.name.endsWith('vic20RasterFrame')), 'the frame hook is linked');
});

// Picture line ranges and the set drawn there: 'mixed' above the first
// entry, because the frame wraps to the last entry's value.
const CHARSET_ENTRIES = [[0, 'mixed'], [21, 'upper'], [43, 'mixed'], [67, 'upper'], [90, 'mixed'], [117, 'upper'], [138, 'mixed'], [155, 'upper'], [170, 'mixed']];
const CHARSET_BORDER = [[0, 'black'], [100, 'red'], [170, 'black']];



/** The picture's pixels on one row, as '#'/'.'. */
function strip(pixel, row, [x0, x1]) {
  let s = '';
  for (let x = x0; x <= x1; x++) s += lit(pixel(x, row)) ? '#' : '.';
  return s;
}

function expectedAt(list, line) {
  let value = list[0][1];
  for (const [start, v] of list) if (line >= start) value = v;
  return value;
}

const referenceProgram = (pointer) => `import { Video } from "@8bitscript/vic20/geometry";
export function main(): void {
    memory.write(0x900F, 0x08);
    for (let cell: usmallint = 0; cell < 506; cell++) {
        memory.write(Video.SCREEN + cell, 66);
        memory.write(Video.COLOR + cell, 1);
    }
    memory.write(0x9005, Video.${pointer});
    while (true) {
        waitFrame();
    }
}
`;

// Both regions unexpanded, and NTSC with 8K: the expanded geometry's
// screen at $1000 is $9005's other high nybble, which the CHARSET byte
// must carry.
const CHARSET_RUNS = {
  ...REGIONS,
  'ntsc-8k': { ...REGIONS.ntsc, flags: ['--hardware', 'ram=8k'] },
};

for (const [region, geometry] of Object.entries(CHARSET_RUNS)) {
  test(`under VICE (${region}), every CHARSET split lands on its picture line, whole, on consecutive frames`, { skip: !onPath('xvic') && 'xvic is not on PATH' }, async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-vic20-charset-'));
    try {
      const reference = {};
      for (const [set, pointer] of [['upper', 'MEMORY_POINTER_UPPERCASE'], ['mixed', 'MEMORY_POINTER_LOWERCASE']]) {
        const file = join(scratch, `ref-${set}.8bs`);
        await writeFile(file, referenceProgram(pointer));
        reference[set] = decode(await shoot(scratch, `ref-${set}-${region}`, [...geometry.flags, '--frames', '822'], file));
      }
      const row = (line) => geometry.top + line;
      // The references must tell the two sets apart on every line, or a
      // line that matched would prove nothing.
      for (let line = 0; line < 184; line++) {
        assert.notEqual(strip(reference.upper, row(line), geometry.picture), strip(reference.mixed, row(line), geometry.picture), `${region}: the two sets differ on picture line ${line}`);
      }
      for (const frames of [822, 823]) {
        const png = decode(await shoot(scratch, `charset-${region}-${frames}`, [...geometry.flags, '--frames', String(frames)], 'test/raster-charset-probe.8bs'));
        const label = `${region}, --frames ${frames}`;
        for (let line = 0; line < 184; line++) {
          const want = expectedAt(CHARSET_ENTRIES, line);
          assert.equal(strip(png, row(line), geometry.picture), strip(reference[want], row(line), geometry.picture), `${label}: picture line ${line} is drawn whole from the ${want} set`);
          const border = expectedAt(CHARSET_BORDER, line);
          assert.ok(COLORS[border](png(5, row(line))), `${label}: border at picture line ${line} is ${border}, got ${png(5, row(line))}`);
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
