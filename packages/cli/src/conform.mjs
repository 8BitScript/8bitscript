// `8bs conform` — does the wasm build of a machine look like the machine?
//
// The wasm modules (docs/project/wasm-primary.md) are this project's own
// implementation of each machine, and the editor's Editor tab, the external
// browser and the shared web build all run on them. That is only worth
// anything if they agree with the real thing, so this builds a probe program
// twice — through the machine's native emulator and through the wasm
// backend — captures one frame of each, and compares them cell by cell.
//
// The comparison needs no table of where each emulator keeps its border. The
// probe (conform/src/grid.8bs) draws a solid cell in each corner of the text
// grid; the bounding box of the lit pixels IS the picture, whatever size the
// emulator made it, and the scale follows from the grid. Each 8x8 cell is then
// read back as a bitmap (ink or not) and an ink colour, and the two sides are
// compared:
//
//   structure  a cell's bitmap differs — a wrong glyph, a missing cell, noise.
//              This is the failure. Tolerance: none, unless asked for.
//   colour     the bitmaps agree but the ink is a different colour — a
//              palette difference, reported with each side's colours. A
//              warning, because "which green" is a decision (the PET's phosphor
//              against VICE's white) before it is a bug; `--strict-colour`
//              makes it a failure.
//
// What this does not do (yet): graphics modes (sprites, bitmap, multicolour),
// anything that moves, or raster timing. It compares text content, the
// character ROM as the machine draws it, and colour RAM. The backlog in
// wasm-primary.md says what comes next.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG } from './png-decode.mjs';
import { encodePNG } from './png.mjs';

export const CELL = 8;

/** The text grid each machine's probe runs on (the release hardware). */
export const GRIDS = {
  pet: { cols: 40, rows: 25 },
  c64: { cols: 40, rows: 25 },
  vic20: { cols: 22, rows: 23 },
  cx16: { cols: 76, rows: 56 },
};

/** Machines with both a native emulator and a wasm build to compare. */
export const CONFORM_MACHINES = ['pet', 'vic20', 'c64', 'cx16'];

const BACKGROUND_DISTANCE = 40; // a pixel this far from the background (any channel) is ink

const px = (img, x, y) => {
  const o = (y * img.width + x) * 4;
  return [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]];
};
const distance = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const key = (c) => `${c[0]},${c[1]},${c[2]}`;

/** The most common colour in the image: the border and the paper. */
export function backgroundOf(img) {
  const counts = new Map();
  for (let i = 0; i < img.width * img.height; i += 1) {
    const k = `${img.rgba[i * 4]},${img.rgba[i * 4 + 1]},${img.rgba[i * 4 + 2]}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = null; let n = -1;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return best.split(',').map(Number);
}

/** Bounding box of every pixel that is not the background, or null. */
export function inkBounds(img, bg) {
  let x0 = img.width; let y0 = img.height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (distance(px(img, x, y), bg) > BACKGROUND_DISTANCE) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * Where the picture is in a capture: the ink bounding box of a probe whose
 * four corner cells are solid, and the scale that makes it `cols x rows`
 * cells of 8 pixels. Throws a sentence a person can act on if it cannot.
 */
export function locatePicture(img, grid, bg = backgroundOf(img)) {
  const box = inkBounds(img, bg);
  if (!box) throw new Error('the capture is one colour: nothing was drawn');
  const w = box.x1 - box.x0 + 1;
  const h = box.y1 - box.y0 + 1;
  const sx = w / (grid.cols * CELL);
  const sy = h / (grid.rows * CELL);
  if (sx < 0.5 || sx > 8 || sy < 0.5 || sy > 8) {
    throw new Error(`the lit area is ${w}x${h}, which is not ${grid.cols}x${grid.rows} cells at any sensible scale (corner cells missing, or noise outside the picture)`);
  }
  return { x0: box.x0, y0: box.y0, sx, sy, w, h };
}

/** Read the picture as a grid of cells: an 8x8 ink bitmap and the ink colour. */
export function readCells(img, rect, grid, bg = backgroundOf(img)) {
  const cells = [];
  for (let r = 0; r < grid.rows; r += 1) {
    for (let c = 0; c < grid.cols; c += 1) {
      const bits = new Uint8Array(CELL * CELL);
      const counts = new Map();
      for (let j = 0; j < CELL; j += 1) {
        for (let i = 0; i < CELL; i += 1) {
          const x = Math.min(img.width - 1, Math.floor(rect.x0 + (c * CELL + i + 0.5) * rect.sx));
          const y = Math.min(img.height - 1, Math.floor(rect.y0 + (r * CELL + j + 0.5) * rect.sy));
          const color = px(img, x, y);
          if (distance(color, bg) > BACKGROUND_DISTANCE) {
            bits[j * CELL + i] = 1;
            counts.set(key(color), (counts.get(key(color)) ?? 0) + 1);
          }
        }
      }
      let ink = null; let n = 0;
      for (const [k, v] of counts) if (v > n) { ink = k.split(',').map(Number); n = v; }
      cells.push({ col: c, row: r, bits, ink });
    }
  }
  return cells;
}

const hamming = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) d += 1;
  return d;
};

/**
 * Compare two cell grids (native `a`, wasm `b`).
 * @returns {{ total:number, structural:object[], colour:object[], palette:{a:string[],b:string[]} }}
 */
export function compareCells(a, b, { colourTolerance = 48, structuralTolerance = 0 } = {}) {
  const structural = []; const colour = [];
  const paletteA = new Set(); const paletteB = new Set();
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]; const y = b[i];
    if (x.ink) paletteA.add(key(x.ink));
    if (y.ink) paletteB.add(key(y.ink));
    const d = hamming(x.bits, y.bits);
    if (d > structuralTolerance) structural.push({ col: x.col, row: x.row, bits: d, native: x.ink, wasm: y.ink });
    else if (x.ink && y.ink && distance(x.ink, y.ink) > colourTolerance) {
      colour.push({ col: x.col, row: x.row, native: x.ink, wasm: y.ink });
    }
  }
  return { total: a.length, structural, colour, palette: { a: [...paletteA], b: [...paletteB] } };
}

/** A montage: the native cells, the wasm cells, and where they differ. */
export function renderDiff(a, b, result, grid) {
  const scale = grid.cols * CELL > 400 ? 1 : 2;
  const gutter = 8;
  const pw = grid.cols * CELL * scale; const ph = grid.rows * CELL * scale;
  const width = pw * 3 + gutter * 2; const height = ph;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 24; rgba[i + 1] = 24; rgba[i + 2] = 28; rgba[i + 3] = 255; }
  const bad = new Map();
  for (const s of result.structural) bad.set(`${s.col},${s.row}`, [255, 64, 64]);
  for (const c of result.colour) if (!bad.has(`${c.col},${c.row}`)) bad.set(`${c.col},${c.row}`, [255, 176, 32]);
  const put = (ox, x, y, color) => {
    for (let dy = 0; dy < scale; dy += 1) {
      for (let dx = 0; dx < scale; dx += 1) {
        const o = ((y * scale + dy) * width + ox + x * scale + dx) * 4;
        rgba[o] = color[0]; rgba[o + 1] = color[1]; rgba[o + 2] = color[2]; rgba[o + 3] = 255;
      }
    }
  };
  const paint = (cells, ox) => {
    for (const cell of cells) {
      for (let j = 0; j < CELL; j += 1) {
        for (let i = 0; i < CELL; i += 1) {
          if (cell.bits[j * CELL + i]) put(ox, cell.col * CELL + i, cell.row * CELL + j, cell.ink ?? [255, 255, 255]);
        }
      }
    }
  };
  paint(a, 0);
  paint(b, pw + gutter);
  for (const [k, color] of bad) {
    const [c, r] = k.split(',').map(Number);
    for (let j = 0; j < CELL; j += 1) {
      for (let i = 0; i < CELL; i += 1) put(2 * (pw + gutter), c * CELL + i, r * CELL + j, color);
    }
  }
  return { width, height, rgba };
}

/**
 * The picture in a wasm capture when the corner cells are not there to find.
 * The wasm page's layout is ours, and always the same shape: the picture
 * centred in its border, at scale 1. Native emulators' borders are not ours
 * (VICE's differ between top and bottom), so they get no such fallback.
 */
export function centredPicture(img, grid) {
  const w = grid.cols * CELL; const h = grid.rows * CELL;
  return { x0: Math.floor((img.width - w) / 2), y0: Math.floor((img.height - h) / 2), sx: 1, sy: 1, w, h };
}

/** Compare two captures of the same probe. */
export function compareCaptures(nativePng, wasmPng, grid, options = {}) {
  const native = decodePNG(nativePng);
  const wasm = decodePNG(wasmPng);
  const bgN = backgroundOf(native); const bgW = backgroundOf(wasm);
  const rectN = locatePicture(native, grid, bgN);
  let rectW; let wasmLocated = 'corner cells';
  try {
    rectW = locatePicture(wasm, grid, bgW);
  } catch {
    // The probe's solid corner cells did not come out (a wasm machine with no
    // reverse video draws nothing for them): say so, and read the picture
    // where the page puts it. The cells that should be solid then differ,
    // which is the finding.
    rectW = centredPicture(wasm, grid);
    wasmLocated = 'centred in the page (no corner cells to find)';
  }
  const cellsN = readCells(native, rectN, grid, bgN);
  const cellsW = readCells(wasm, rectW, grid, bgW);
  const result = compareCells(cellsN, cellsW, options);
  return {
    ...result, grid,
    native: { width: native.width, height: native.height, picture: rectN, background: bgN },
    wasm: { width: wasm.width, height: wasm.height, picture: rectW, background: bgW, located: wasmLocated },
    diff: renderDiff(cellsN, cellsW, result, grid),
  };
}

// ---- the command ----------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
export const CONFORM_PROJECT = resolve(here, '..', 'conform');
const BIN = resolve(here, '..', 'bin', '8bs.mjs');

export const USAGE = `Usage: 8bs conform [<machine>...] [--program <name>] [--frames <n>]
                  [--out <dir>] [--project <dir>] [--strict-colour]
                  [--colour-tolerance <n>] [--structure-tolerance <n>]

Build a probe program for each machine twice — through its native emulator and
through the wasm backend (the Editor tab's, and the browser's, build) — capture
one frame of each, and compare them cell by cell. The probe draws solid corner
cells (which locate the picture), the printable ASCII ramp in normal and reverse
video, and one cell per text colour, then holds still.

  <machine>      pet, vic20, c64 or cx16 (default: all four)
  --program      the probe, from conform/ in the CLI package (default: grid)
  --frames       how many frames the wasm run lasts before the capture (default: 300)
  --out          where the captures and diff images go (default: dist/conform)
  --project      a different project of probes (default: the CLI's own conform/)
  --strict-colour           a colour difference fails too (default: it warns)
  --colour-tolerance <n>    largest per-channel RGB difference still the same colour (default: 48)
  --structure-tolerance <n> pixels of an 8x8 cell allowed to differ (default: 0)

Exit status: 0 when every machine's cells match, 1 when any differ (or a capture
fails), 2 for bad arguments. Writes <out>/<program>-<machine>.{native,wasm,diff}.png
and <out>/<program>.json.
`;

/** Parse the command line. Returns `{ error }` rather than throwing. */
export function parseConformArgs(argv) {
  const options = {
    machines: [], program: 'grid', frames: 300, out: 'dist/conform', project: CONFORM_PROJECT,
    strictColour: false, colourTolerance: 48, structuralTolerance: 0, help: false,
  };
  const number = (name, value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} takes a whole number, not '${value}'`);
    return n;
  };
  try {
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      const value = () => {
        if (i + 1 >= argv.length) throw new Error(`${arg} takes a value`);
        i += 1;
        return argv[i];
      };
      if (arg === '--help' || arg === '-h') options.help = true;
      else if (arg === '--program') options.program = value();
      else if (arg === '--frames') options.frames = number('--frames', value());
      else if (arg === '--out') options.out = value();
      else if (arg === '--project') options.project = resolve(value());
      else if (arg === '--colour-tolerance') options.colourTolerance = number('--colour-tolerance', value());
      else if (arg === '--structure-tolerance') options.structuralTolerance = number('--structure-tolerance', value());
      else if (arg === '--strict-colour') options.strictColour = true;
      else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
      else if (CONFORM_MACHINES.includes(arg)) options.machines.push(arg);
      else throw new Error(`'${arg}' is not a machine with both a native emulator and a wasm build (${CONFORM_MACHINES.join(', ')})`);
    }
  } catch (err) {
    return { error: err.message };
  }
  if (options.machines.length === 0) options.machines = [...CONFORM_MACHINES];
  return options;
}

/**
 * One capture, by running this CLI: `8bs run <machine> --screenshot` natively,
 * or with `--web --frames` for the wasm build. Returns `{ ok }` or `{ ok: false, error }`.
 */
export function captureOnce(machine, options, wasm, file) {
  const args = [BIN, 'run', machine, '--program', options.program, '--screenshot', file];
  if (wasm) args.push('--web', '--frames', String(options.frames));
  const r = spawnSync(process.execPath, args, { cwd: options.project, encoding: 'utf8', timeout: 300000, env: process.env });
  if (r.status === 0 && existsSync(file)) return { ok: true };
  const tail = `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').filter((l) => !/^warning /.test(l)).slice(-2).join(' | ');
  return { ok: false, error: tail.slice(0, 300) || `exit ${r.status}` };
}

const colourName = (c) => (c ? `rgb(${c.join(',')})` : 'none');

/**
 * Run the command. `capture` is injectable for tests.
 * @returns {Promise<number>} the exit status
 */
export async function conformCommand(argv, { capture = captureOnce, write = (s) => process.stdout.write(s) } = {}) {
  const options = parseConformArgs(argv);
  if (options.error) { process.stderr.write(`8bs conform: ${options.error}\n\n${USAGE}`); return 2; }
  if (options.help) { write(USAGE); return 0; }
  const out = resolve(options.project, options.out);
  mkdirSync(out, { recursive: true });
  let failed = false;
  const report = { program: options.program, frames: options.frames, machines: {} };
  write(`8bs conform ${options.program}: native emulator against the wasm build\n\n`);
  for (const machine of options.machines) {
    const stem = join(out, `${options.program}-${machine}`);
    const nativeFile = `${stem}.native.png`; const wasmFile = `${stem}.wasm.png`;
    const wasm = capture(machine, options, true, wasmFile);
    const native = capture(machine, options, false, nativeFile);
    if (!wasm.ok || !native.ok) {
      failed = true;
      const what = !wasm.ok ? `the wasm build failed: ${wasm.error}` : `the native capture failed: ${native.error}`;
      write(`  ${machine.padEnd(6)} FAIL  ${what}\n`);
      report.machines[machine] = { ok: false, error: what };
      continue;
    }
    let result;
    try {
      result = compareCaptures(readFileSync(nativeFile), readFileSync(wasmFile), GRIDS[machine], options);
    } catch (err) {
      failed = true;
      write(`  ${machine.padEnd(6)} FAIL  ${err.message}\n`);
      report.machines[machine] = { ok: false, error: err.message };
      continue;
    }
    writeFileSync(`${stem}.diff.png`, encodePNG(result.diff.width, result.diff.height, result.diff.rgba));
    const structuralBad = result.structural.length > 0;
    const colourBad = result.colour.length > 0;
    const bad = structuralBad || (colourBad && options.strictColour);
    if (bad) failed = true;
    const verdict = structuralBad ? 'DIFFER' : colourBad ? (options.strictColour ? 'DIFFER' : 'colours') : 'match ';
    write(`  ${machine.padEnd(6)} ${verdict} ${String(result.total).padStart(5)} cells: ${result.structural.length} structure, ${result.colour.length} colour`
      + `   (native ${result.native.width}x${result.native.height}, wasm ${result.wasm.width}x${result.wasm.height})\n`);
    for (const s of result.structural.slice(0, 5)) {
      write(`           cell ${s.col},${s.row}: ${s.bits} of 64 pixels differ (native ink ${colourName(s.native)}, wasm ink ${colourName(s.wasm)})\n`);
    }
    if (result.structural.length > 5) write(`           ... and ${result.structural.length - 5} more cells\n`);
    if (result.wasm.located !== 'corner cells') write(`           the wasm picture is ${result.wasm.located}\n`);
    if (colourBad) {
      write(`           ink colours  native: ${result.palette.a.slice(0, 6).join(' ')}${result.palette.a.length > 6 ? ' ...' : ''}\n`);
      write(`                         wasm: ${result.palette.b.slice(0, 6).join(' ')}${result.palette.b.length > 6 ? ' ...' : ''}\n`);
    }
    report.machines[machine] = {
      ok: !bad, cells: result.total, structural: result.structural.length, colour: result.colour.length,
      structuralCells: result.structural.slice(0, 200).map((s) => ({ col: s.col, row: s.row, bits: s.bits })),
      palette: result.palette, native: result.native, wasm: result.wasm,
    };
  }
  writeFileSync(join(out, `${options.program}.json`), `${JSON.stringify(report, null, 2)}\n`);
  write(`\nCaptures and diff images: ${out}\n`);
  return failed ? 1 : 0;
}
