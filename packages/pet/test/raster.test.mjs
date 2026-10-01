// The PET's character-set raster split (the 3032 model tag), run for
// real under xpet and read by pixel: test/raster-probe.8bs builds a list
// once, enable()s it, and keeps a frame loop running, and the split must
// land on its picture line and hold still from frame to frame — the same
// discipline packages/vic20/test/raster.test.mjs holds its own machine
// to. packages/pet/AGENTS.md, "Raster: character-set switching", has the
// research and the measured constants this driver is built from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { link } from '../../compiler/index.mjs';
import { loadCatalog, resolveHardware, stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHECKOUT = join(ROOT, '..', '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');
const PROBE = join(HERE, 'raster-probe.8bs');
const PROBE_4032 = join(HERE, 'raster-probe.pet.4032.8bs');

test('the raster probe links clean for the PET 3032, with the frame hook and the plan builder in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, {
    machine: 'pet', facts: factsFor('3032'), tags: ['3032'], checkout: CHECKOUT,
  });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const fn of ['petRasterFrame', 'raster_commit', 'raster_enable']) {
    assert.ok(names.some((name) => name === fn || name.endsWith(fn)), `${fn} in ${names.join(', ')}`);
  }
});

test('the raster probe links clean for the PET 4032, with the frame hook and the plan builder in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE_4032, 'utf8'), PROBE_4032, {
    machine: 'pet', facts: factsFor('4032'), tags: ['4032'], checkout: CHECKOUT,
  });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const fn of ['petRasterFrame', 'raster_commit', 'raster_enable']) {
    assert.ok(names.some((name) => name === fn || name.endsWith(fn)), `${fn} in ${names.join(', ')}`);
  }
});

test('the 3032 and 4032 model values answer video.raster; every other PET model still answers false, including the default', () => {
  assert.equal(factsFor('3032')['video.raster'], true);
  assert.equal(factsFor('4032')['video.raster'], true);
  assert.equal(stockFacts('pet')['video.raster'], false, 'the default model (2001)');
  for (const model of ['2001', '3008', '3016', '4016', '8032']) {
    assert.equal(factsFor(model)['video.raster'], false, model);
  }
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

async function shoot(scratch, name, extra, model = '3032', probe = 'test/raster-probe.8bs') {
  const shot = join(scratch, `${name}.png`);
  const { code, stdout, stderr } = await runCli(['run', 'pet', '--hardware', `model=${model}`, '--checkout', CHECKOUT, ...extra, '--screenshot', shot, probe]);
  assert.equal(code, 0, `8bs run pet --hardware model=${model} ${extra.join(' ')} --screenshot failed:\n${stdout}${stderr}`);
  return readFileSync(shot);
}

/** This package's facts with `model` overridden — stockFacts() only ever resolves the catalog's default (2001). */
function factsFor(model) {
  const resolved = resolveHardware(loadCatalog('pet'), { overrides: { model } });
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  return resolved.hardware.facts;
}

// A minimal, whole-image PNG decoder: packages/cli/src/png.mjs's own
// pixelAt() re-inflates and re-unfilters the file from row 0 on every
// single call, which is fine for the handful of points the C64/VIC-20
// tests read but far too slow for the whole-row comparisons this test
// needs (discovered writing this file: a few hundred calls took minutes).
// Decoding once into a flat buffer and indexing it directly is what
// packages/vic20's own research scratch settled on for the same reason.
function decodePng(buf) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(signature)) throw new Error('not a PNG');
  let offset = 8; let width = 0; let height = 0; let depth = 0; let colorType = 0;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not 8`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const out = pixels.subarray(row * stride, (row + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      out[i] = v;
    }
    previous = out;
  }
  return { width, height, channels, pixels };
}

// A green/black row of pixels, from x0 (inclusive) to x1 (exclusive), as a
// string of '#'/'.' — a PETSCII glyph is monochrome, so the green channel
// alone tells a lit pixel from a dark one.
function stripRow(img, y, x0, x1) {
  let s = '';
  for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * img.channels;
    s += img.pixels[i + 1] > 100 ? '#' : '.';
  }
  return s;
}

// The text columns only — x 35-374 on xpet's 3032 capture (384 wide); the
// border on both sides is always blank and would falsely "agree" with
// either reference.
const X0 = 35; const X1 = 374;
// Picture line 0 is capture row 8 (packages/pet/AGENTS.md).
const ROW = (line) => 8 + line;

test('under xpet, the character-set split lands on its picture lines and holds frame to frame', { skip: !onPath('xpet') && 'xpet is not on PATH' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-pet-raster-'));
  try {
    // Two references: the whole screen held at graphics ($0C) and at text
    // ($0E) for the entire capture, code 1 in every cell — the same
    // reference-capture technique the research behind this driver used.
    const refGraphics = await (async () => {
      const src = `export function main(): void {
    for (let cell: usmallint = 0; cell < 1000; cell++) {
        memory.write(0x8000 + cell, 1);
    }
    memory.write(0xE84C, 0x0C);
    while (true) {
        waitFrame();
    }
}
`;
      const file = join(scratch, 'ref-graphics.8bs');
      await import('node:fs/promises').then((fs) => fs.writeFile(file, src));
      const shotPath = join(scratch, 'ref-graphics.png');
      const { code, stdout, stderr } = await runCli(['run', 'pet', '--hardware', 'model=3032', '--checkout', CHECKOUT, '--frames', '300', '--screenshot', shotPath, file]);
      assert.equal(code, 0, `${stdout}${stderr}`);
      return decodePng(readFileSync(shotPath));
    })();
    const refText = await (async () => {
      const src = `export function main(): void {
    for (let cell: usmallint = 0; cell < 1000; cell++) {
        memory.write(0x8000 + cell, 1);
    }
    memory.write(0xE84C, 0x0E);
    while (true) {
        waitFrame();
    }
}
`;
      const file = join(scratch, 'ref-text.8bs');
      await import('node:fs/promises').then((fs) => fs.writeFile(file, src));
      const shotPath = join(scratch, 'ref-text.png');
      const { code, stdout, stderr } = await runCli(['run', 'pet', '--hardware', 'model=3032', '--checkout', CHECKOUT, '--frames', '300', '--screenshot', shotPath, file]);
      assert.equal(code, 0, `${stdout}${stderr}`);
      return decodePng(readFileSync(shotPath));
    })();

    const H = refGraphics.height;
    const refRow = { graphics: [], text: [] };
    for (let y = 0; y < H; y++) {
      refRow.graphics.push(stripRow(refGraphics, y, X0, X1));
      refRow.text.push(stripRow(refText, y, X0, X1));
    }

    for (const frames of [300, 350]) {
      const png = decodePng(await shoot(scratch, `split-${frames}`, ['--frames', String(frames)]));
      const kindAt = (y) => {
        const r = stripRow(png, y, X0, X1);
        if (r === refRow.graphics[y]) return 'graphics';
        if (r === refRow.text[y]) return 'text';
        return null; // either this row is identical in both fonts (common — see
        // packages/pet/AGENTS.md on the comparator bug this avoids), or a
        // real torn row; distinguished below by checking it's an
        // already-known-identical row, never by assuming which.
      };
      const label = `--frames ${frames}`;

      // Graphics well above the first split (picture lines 8-20, clear of
      // the boot-state band immediately at line 0).
      for (const line of [8, 12, 16, 20]) {
        assert.equal(kindAt(ROW(line)), 'graphics', `${label}: picture line ${line} is graphics`);
      }
      // Text well inside the middle band (lines 40-120).
      for (const line of [40, 60, 80, 100, 120]) {
        assert.equal(kindAt(ROW(line)), 'text', `${label}: picture line ${line} is text`);
      }
      // Graphics again well below the second split (lines 150-190).
      for (const line of [150, 160, 170, 190]) {
        assert.equal(kindAt(ROW(line)), 'graphics', `${label}: picture line ${line} is graphics again`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// Picture line 0 is capture row 36 on the 4032 (packages/pet/AGENTS.md) —
// different from the 3032's row 8, since the CRTC board's border is a
// different height.
const ROW_4032 = (line) => 36 + line;

test('under xpet, the 4032 eight-entry split lands on every picture line and holds frame to frame', { skip: !onPath('xpet') && 'xpet is not on PATH' }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-pet-raster-4032-'));
  try {
    const refGraphics = await (async () => {
      const src = `export function main(): void {
    for (let cell: usmallint = 0; cell < 1000; cell++) {
        memory.write(0x8000 + cell, 1);
    }
    memory.write(0xE84C, 0x0C);
    while (true) {
        waitFrame();
    }
}
`;
      const file = join(scratch, 'ref-graphics.8bs');
      await import('node:fs/promises').then((fs) => fs.writeFile(file, src));
      const shotPath = join(scratch, 'ref-graphics.png');
      const { code, stdout, stderr } = await runCli(['run', 'pet', '--hardware', 'model=4032', '--checkout', CHECKOUT, '--frames', '300', '--screenshot', shotPath, file]);
      assert.equal(code, 0, `${stdout}${stderr}`);
      return decodePng(readFileSync(shotPath));
    })();
    const refText = await (async () => {
      const src = `export function main(): void {
    for (let cell: usmallint = 0; cell < 1000; cell++) {
        memory.write(0x8000 + cell, 1);
    }
    memory.write(0xE84C, 0x0E);
    while (true) {
        waitFrame();
    }
}
`;
      const file = join(scratch, 'ref-text.8bs');
      await import('node:fs/promises').then((fs) => fs.writeFile(file, src));
      const shotPath = join(scratch, 'ref-text.png');
      const { code, stdout, stderr } = await runCli(['run', 'pet', '--hardware', 'model=4032', '--checkout', CHECKOUT, '--frames', '300', '--screenshot', shotPath, file]);
      assert.equal(code, 0, `${stdout}${stderr}`);
      return decodePng(readFileSync(shotPath));
    })();

    const H = refGraphics.height;
    const refRow = { graphics: [], text: [] };
    for (let y = 0; y < H; y++) {
      refRow.graphics.push(stripRow(refGraphics, y, X0, X1));
      refRow.text.push(stripRow(refText, y, X0, X1));
    }

    for (const frames of [300, 350]) {
      const png = decodePng(await shoot(scratch, `split4032-${frames}`, ['--frames', String(frames)], '4032', PROBE_4032));
      const kindAt = (y) => {
        const r = stripRow(png, y, X0, X1);
        if (r === refRow.graphics[y]) return 'graphics';
        if (r === refRow.text[y]) return 'text';
        return null; // identical-in-both-fonts row (packages/pet/AGENTS.md), or a
        // real torn row; distinguished below by checking it's an
        // already-known-identical row, never by assuming which.
      };
      const label = `--frames ${frames}`;

      // Before the first entry: whatever the LAST entry (line 160,
      // graphics) left in effect at the end of the previous frame — this
      // is what caught the off-by-one entry-reading mistake during this
      // driver's own calibration (rasterline.pet.4032.8bs's header), so
      // it is asserted here deliberately, not skipped as "boot state".
      for (const line of [5, 10, 15]) {
        assert.equal(kindAt(ROW_4032(line)), 'graphics', `${label}: picture line ${line} is graphics (carried over)`);
      }
      // Each entry's own band, sampled well clear of its neighbors'
      // transitions (every band is 20 lines wide; these sit 5-15 lines in).
      const bands = [
        [20, 'text'], [40, 'graphics'], [60, 'text'], [80, 'graphics'],
        [100, 'text'], [120, 'graphics'], [140, 'text'], [160, 'graphics'],
      ];
      for (const [start, kind] of bands) {
        for (const offset of [5, 10, 15]) {
          const line = start + offset;
          assert.equal(kindAt(ROW_4032(line)), kind, `${label}: picture line ${line} is ${kind}`);
        }
      }
      // The last entry (graphics, from line 160) holds to the bottom of
      // the picture.
      assert.equal(kindAt(ROW_4032(190)), 'graphics', `${label}: picture line 190 is graphics (last entry holds)`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
