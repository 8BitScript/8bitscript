// The C64's hardware layers, run for real under x64sc: the raster list,
// the wobble band over raster.setValue, bitmap mode, the region probe,
// and REU transfers. Each probe program links clean for the C64 without
// an emulator; each is also run headless and its screenshot read at a
// few pixels — the probe encodes its answer in colors, as
// test/reu-probe.8bs does.
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

const PROBES = {
  raster: ['raster-probe.8bs', ['raster_at', 'raster_enable']],
  wobble: ['wobble-probe.8bs', ['raster_at', 'raster_setValue', 'raster_enable']],
  bitmap: ['bitmap-probe.8bs', ['bitmap_enter', 'bitmap_plot', 'bitmap_fillColors', 'sprites_setShapeByte']],
  region: ['region-probe.8bs', ['detectRegion', 'sid_detectRegion', 'sid_frequencyOf']],
  reuTransfer: ['reu-transfer-probe.8bs', ['reu_stash', 'reu_fetch', 'reu_swap', 'reu_verify', 'reu_fillReu']],
};

for (const [name, [file, functions]] of Object.entries(PROBES)) {
  test(`the ${name} probe links clean for the C64, with its functions in the IR`, () => {
    const path = join(HERE, file);
    const { ir, diagnostics } = link(readFileSync(path, 'utf8'), path, { machine: 'c64', facts: stockFacts('c64') });
    assert.deepEqual(diagnostics, []);
    const names = ir.functions.map((f) => f.name);
    for (const fn of functions) assert.ok(names.includes(fn), fn);
    assert.equal(ir.nativeSources.length, 1, 'the package\'s raster.s rides along');
  });
}

// The rasterline probe reaches this package through @8bitscript/raster, so
// its link resolves @8bitscript/* through this checkout rather than
// node_modules (packages/c64 has no node_modules of its own).
const CHECKOUT = join(ROOT, '..', '..');

test('the rasterline probe links clean for the C64, @8bitscript/raster resolving to this package\'s slot layer', () => {
  const path = join(HERE, 'rasterline-probe.8bs');
  const { ir, diagnostics } = link(readFileSync(path, 'utf8'), path, {
    machine: 'c64', facts: stockFacts('c64'), checkout: CHECKOUT,
  });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  assert.ok(names.some((name) => /raster_at/.test(name)), `the slot layer and the address list link: ${names.join(', ')}`);
  assert.ok(names.some((name) => /raster_enable/.test(name)), 'enable() delegates through');
  assert.equal(ir.nativeSources.length, 1, 'the package\'s raster.s rides along');
});

// --- Under VICE ---------------------------------------------------------

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

async function shoot(scratch, name, probe, extra = []) {
  const shot = join(scratch, `${name}.png`);
  const { code, stdout, stderr } = await runCli(['run', 'c64', ...extra, '--screenshot', shot, `test/${probe}`]);
  assert.equal(code, 0, `8bs run c64 ${extra.join(' ')} --screenshot failed:\n${stdout}${stderr}`);
  return readFileSync(shot);
}

// VICE's palette, by which channel dominates.
const isRed = ([r, g, b]) => r > g + 40 && r > b + 40;
const isGreen = ([r, g, b]) => g > r + 30 && g > b + 30;
const isBlue = ([r, g, b]) => b > r + 40 && b > g + 40;
const isYellow = ([r, g, b]) => r > 200 && g > 200 && b < 200;
const isWhite = ([r, g, b]) => r > 200 && g > 200 && b > 200;
const isDark = ([r, g, b]) => r < 60 && g < 60 && b < 60;

test('under VICE, the raster list changes the border color at its lines, top to bottom', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    const png = await shoot(scratch, 'raster', 'raster-probe.8bs');
    // x64sc's NTSC screenshot is 384 x 247, the border column at x = 4, and
    // raster line L at about y = L - 20 in it (measured: the first text
    // row, lines 51-58, is at y 31). The bands: blue, red from line 100,
    // green from 150, yellow from 200, blue from 240.
    assert.ok(isBlue(pixelAt(png, 4, 30)), `line ~50: blue, got ${pixelAt(png, 4, 30)}`);
    assert.ok(isRed(pixelAt(png, 4, 105)), `line ~125: red, got ${pixelAt(png, 4, 105)}`);
    assert.ok(isGreen(pixelAt(png, 4, 155)), `line ~175: green, got ${pixelAt(png, 4, 155)}`);
    assert.ok(isYellow(pixelAt(png, 4, 205)), `line ~225: yellow, got ${pixelAt(png, 4, 205)}`);
    assert.ok(isBlue(pixelAt(png, 4, 235)), `line ~255: blue, got ${pixelAt(png, 4, 235)}`);
    // The background inside the picture: green when $FFFA/$FFFB and
    // $FFFE/$FFFF held the same non-zero vector before enable().
    assert.ok(isGreen(pixelAt(png, 200, 60)), `the .init vectors: a green background, got ${pixelAt(png, 200, 60)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, the portable rasterline slots land on $D020/$D021/$D016, picture lines 50 raster lines down', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    const png = await shoot(scratch, 'rasterline', 'rasterline-probe.8bs', ['--checkout', CHECKOUT]);
    // Same geometry as the raster test: raster line L at about y = L - 20,
    // the border column at x = 4, the picture at x = 32 onward. Picture
    // line 0 is raster line 50, so the red border and green background
    // both start around y = 30.
    assert.ok(isRed(pixelAt(png, 4, 100)), `picture lines 0-149: a red border, got ${pixelAt(png, 4, 100)}`);
    assert.ok(isBlue(pixelAt(png, 4, 200)), `picture line 150 on: a blue border, got ${pixelAt(png, 4, 200)}`);
    assert.ok(isGreen(pixelAt(png, 200, 60)), `the playfield: green from picture line 0, got ${pixelAt(png, 200, 60)}`);
    // Yellow below picture line 180 proves the refusal: the probe adds
    // this split only after at(200, ...) came back false.
    assert.ok(isYellow(pixelAt(png, 200, 220)), `picture line 180 on: the refusal's yellow band, got ${pixelAt(png, 200, 220)}`);
    // The SCROLL_X band: picture lines 100-129 (y ≈ 130-159) carry
    // XSCROLL 7, and every row's columns 0-19 are white blocks, so each
    // scanline's white/green edge sits at picture pixel 160 plus that
    // line's shift — rows inside the band sit exactly 7 pixels right of
    // the straight rows above.
    const edgeAt = (y) => {
      for (let px = 155; px <= 172; px++) if (!isWhite(pixelAt(png, 32 + px, y))) return px;
      return 173;
    };
    const straight = edgeAt(60);
    assert.ok(straight < 165, `a straight row's edge near pixel 160, got ${straight}`);
    assert.equal(edgeAt(142), straight + 7, `inside the band the edge shifts 7 pixels right of ${straight}`);
    assert.equal(edgeAt(150), straight + 7, 'and the whole band moved, not one scanline');
    // 38 columns held INSIDE the band: the probe goes narrow before
    // building the list, so picture pixels 0-6 stay border there — a
    // $D016 byte that forced CSEL back to 40 columns would fill them
    // with the picture instead.
    assert.ok(isRed(pixelAt(png, 32 + 2, 142)), `narrow mode's left border inside the band, got ${pixelAt(png, 32 + 2, 142)}`);
    assert.ok(isRed(pixelAt(png, 32 + 2, 60)), `and outside it, got ${pixelAt(png, 32 + 2, 60)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, the wobble band shifts scanlines by different XSCROLL values inside its $D021 splits', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    // The probe switches its below-band split from blue to green only
    // after 60 waitFrame() returns, so give the program comfortably more
    // than 60 frames past autostart (~500 frames is ~8.5M cycles).
    const png = await shoot(scratch, 'wobble', 'wobble-probe.8bs', ['--frames', '500']);
    // The probe fills columns 0-19 with white blocks, so each scanline's
    // white/background edge sits at picture pixel 160 plus that line's
    // XSCROLL. Its band (raster lines 100-147, 24 $D016 entries at one
    // per two scanlines, red $D021 behind it) lands at y ≈ 75-122 in the
    // capture — this probe's picture runs about 5 lines above the
    // y = L - 20 estimate the raster test uses — so the rows sampled
    // here stay well inside it.
    const at = (px, y) => pixelAt(png, 32 + px, y);
    const edgeAt = (y) => {
      for (let px = 158; px <= 170; px++) if (!isWhite(at(px, y))) return px;
      return 171;
    };
    const edges = new Set();
    for (let y = 80; y <= 116; y++) {
      assert.ok(isWhite(at(150, y)), `y ${y}: white blocks at any shift, got ${at(150, y)}`);
      assert.ok(isRed(at(200, y)), `y ${y}: the band's red background, got ${at(200, y)}`);
      edges.add(edgeAt(y));
    }
    assert.ok(edges.size >= 2, `scanlines inside the band sit at different offsets: edges at ${[...edges].join(', ')}`);
    // A row inside the band differs from a row outside it: the band's
    // background is red against black above the first split, and its
    // widest shift beats the straight rows' edge.
    assert.ok(isDark(at(200, 40)), `above the splits: black, got ${at(200, 40)}`);
    assert.ok(isWhite(at(150, 140)), `blocks outside the band too, got ${at(150, 140)}`);
    assert.ok(Math.max(...edges) > edgeAt(40), `a band row shifted past the straight rows' edge at ${edgeAt(40)}`);
    // The frame-loop witness: the below-band split is BUILT blue, and only
    // the loop — 60 waitFrame() returns after raster.enable()'s cli, then
    // one raster.setValue — turns it green. Green here proves waitFrame()
    // kept returning with the raster IRQ still firing in the captured
    // frame: a hung waitFrame leaves this pixel blue, and a dead handler
    // leaves no splits at all (the red/black asserts above would fail).
    assert.ok(isGreen(at(200, 140)), `below the band, green only after 60 live waitFrame() frames, got ${at(200, 140)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, bitmap mode draws a plotted rectangle on colored cells and a sprite from a block under the I/O area', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    // 4800 plotted pixels are read-modify-writes over 16-bit offsets: the
    // default capture window (5M cycles, most of it autostart) catches the
    // rectangle a quarter drawn, so give the program ~15M cycles.
    const png = await shoot(scratch, 'bitmap', 'bitmap-probe.8bs', ['--frames', '900']);
    // The picture's pixel (px, py) is at (32 + px, 31 + py) in the
    // screenshot; a sprite at VIC (X, Y) has its top-left at picture
    // (X - 24, Y - 50).
    const at = (px, py) => pixelAt(png, 32 + px, 31 + py);
    assert.ok(isWhite(at(80, 70)), `inside the rectangle: white, got ${at(80, 70)}`);
    assert.ok(isBlue(at(200, 70)), `outside it: blue cells, got ${at(200, 70)}`);
    assert.ok(isYellow(at(250 - 24 + 12, 180 - 50 + 10)), `the sprite: yellow, got ${at(238, 140)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, detectRegion says NTSC under -model ntsc and PAL under -model c64', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    const ntsc = await shoot(scratch, 'ntsc', 'region-probe.8bs');
    assert.ok(isYellow(pixelAt(ntsc, 4, 4)), `NTSC: a yellow border, got ${pixelAt(ntsc, 4, 4)}`);
    const pal = await shoot(scratch, 'pal', 'region-probe.8bs', ['--pal']);
    assert.ok(isGreen(pixelAt(pal, 4, 4)), `PAL: a green border, got ${pixelAt(pal, 4, 4)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('under VICE, REU transfers round-trip the screen through a 512 KiB unit, and a stock C64 tries none', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-layers-'));
  try {
    const reu = await shoot(scratch, 'reu512', 'reu-transfer-probe.8bs', ['--hardware', 'ram=reu512']);
    assert.ok(isGreen(pixelAt(reu, 4, 4)), `512 KiB: a green border, got ${pixelAt(reu, 4, 4)}`);
    const none = await shoot(scratch, 'none', 'reu-transfer-probe.8bs');
    assert.ok(isRed(pixelAt(none, 4, 4)), `no REU: a red border, got ${pixelAt(none, 4, 4)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
