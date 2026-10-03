// @8bitscript/cx16/rasterline — the X16 behind @8bitscript/raster, on
// VERA's line interrupt. Two layers: the probe links clean for the X16
// with the stock sheet (no emulator needed), and, when x16emu and ffmpeg
// are installed, it is run and every split is read off the screenshot's
// rows: the first row in the new state, and the row above it whole in the
// old one. packages/cx16/AGENTS.md, "Raster splits", has the measurements
// behind each number here.
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
const PROBE = join(HERE, 'raster-probe.8bs');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the package exports ./rasterline, and the stock sheet answers video.raster', () => {
  assert.equal(pkg['8bitscript'].exports['./rasterline'], './src/rasterline.8bs');
  assert.equal(stockFacts('cx16')['video.raster'], true);
});

test('the probe links clean for the X16, and the list, its plan and the handler are real functions', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'cx16', facts: stockFacts('cx16') });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const name of ['raster_clear', 'raster_at', 'raster_commit', 'raster_place', 'raster_copyLine', 'raster_setValue', 'raster_enable']) {
    assert.ok(names.includes(name), name);
  }
});

test('the three capability constants fold to what the driver accepts', () => {
  const src = `import { raster } from "../src/rasterline.8bs";
export function main(): void {
    if (raster.COLORS) { raster.clear(); }
    if (raster.FINE_SCROLL) { raster.clear(); }
    if (raster.CHARSET) { raster.clear(); }
    return;
}
`;
  const { ir, diagnostics } = link(src, join(HERE, 'raster-constants.8bs'), { machine: 'cx16', facts: stockFacts('cx16') });
  assert.deepEqual(diagnostics, []);
  const guards = ir.functions.find((f) => f.name === 'main').body.filter((s) => s.kind === 'if');
  assert.equal(guards.length, 3);
  for (const guard of guards) {
    assert.equal(guard.test.kind, 'const');
    assert.equal(Boolean(guard.test.value), true);
  }
});

test('the handler leaves the KERNAL frame the way the KERNAL does, and acknowledges only the LINE bit', () => {
  const src = readFileSync(join(ROOT, 'src', 'rasterline.8bs'), 'utf8');
  // kernal/cbm/irq.s ends its handler `ply / plx / pla / rti`; NMOS spelling.
  assert.match(src, /pla\n\s+tay\n\s+pla\n\s+tax\n\s+pla\n\s+rti/);
  assert.match(src, /lda #\$02\n\s+sta \$9F27/);
  assert.doesNotMatch(src, /lda #\$0[13]\n\s+sta \$9F27/, 'the VSYNC bit is waitFrame()\'s to acknowledge');
});

test('input.poll() and mouse.poll() put the I flag back instead of leaving a raster handler silenced', () => {
  for (const file of ['input.8bs', 'mouse.8bs']) {
    const src = readFileSync(join(ROOT, 'src', file), 'utf8');
    assert.match(src, /php\n\s+sei/, `${file} saves the flag before its sei`);
    assert.match(src, /plp\n\s+\}/, `${file} restores it after the KERNAL calls`);
  }
});

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}

function runCli(args, { timeoutMs = 150_000 } = {}) {
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

const RED = [0x88, 0x00, 0x00];
const YELLOW = [0xee, 0xee, 0x77];
const CYAN = [0xaa, 0xff, 0xee];
const BLACK = [0x00, 0x00, 0x00];
const BLUE = [0x00, 0x00, 0xaa];

// The first column of text pixels in a row, from the picture's left edge
// (x 16): 17 is an ISO 'H' unscrolled, 21 the same scrolled 4 right, 24
// the PETSCII set's glyph for the same code.
function firstLit(png, y) {
  for (let x = 16; x < 48; x += 1) {
    const [r, g] = pixelAt(png, x, y);
    if (r > 200 && g > 200) return x;
  }
  return -1;
}

test(
  'under x16emu, every slot splits on its own line, whole, and setValue lands while waitFrame() and input.poll() run',
  { skip: onPath('x16emu') && onPath('ffmpeg') ? false : 'x16emu and ffmpeg are not both on PATH' },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-cx16-raster-'));
    try {
      const shot = join(scratch, 'raster.png');
      // 300 frames: past the probe's sixtieth loop, when the line-200
      // border entry has been rewritten to cyan.
      const { code, stdout, stderr } = await runCli(
        ['run', 'cx16', '--screenshot', shot, '--frames', '300', 'test/raster-probe.8bs'],
      );
      assert.equal(code, 0, `8bs run cx16 --screenshot failed:\n${stdout}${stderr}`);
      const png = readFileSync(shot);
      // Picture line L is PNG row 16 + L. Both side borders are read, so a
      // write that lands mid-line (one side old, the other new) fails.
      const border = (y, color, what) => {
        assert.deepEqual(pixelAt(png, 4, y), color, `${what}: left border at row ${y}`);
        assert.deepEqual(pixelAt(png, 632, y), color, `${what}: right border at row ${y}`);
      };
      border(30, CYAN, 'above line 40: the wrapped line-200 value, rewritten by setValue');
      border(55, CYAN, 'line 39');
      border(56, RED, 'BORDER at line 40');
      border(115, RED, 'line 99');
      border(116, YELLOW, 'BORDER at line 100');
      border(117, YELLOW, 'line 101: the adjacent entry takes the late path');
      border(118, RED, 'line 102: the adjacent entry, a line late');
      border(215, RED, 'line 199');
      border(216, CYAN, 'BORDER at line 200');
      // BACKGROUND: the background's palette entry, read right of the text.
      assert.deepEqual(pixelAt(png, 600, 95), BLACK, 'line 79 background');
      assert.deepEqual(pixelAt(png, 344, 96), BLUE, 'BACKGROUND at line 80, left of the strip');
      assert.deepEqual(pixelAt(png, 600, 96), BLUE, 'BACKGROUND at line 80, right of the strip');
      assert.deepEqual(pixelAt(png, 600, 215), BLUE, 'line 199 background');
      assert.deepEqual(pixelAt(png, 600, 216), BLACK, 'BACKGROUND back at line 200');
      // SCROLL_X 4 from line 120; CHARSET 1 from line 160; both back at 200.
      assert.equal(firstLit(png, 131), 17, 'line 115: unscrolled');
      assert.equal(firstLit(png, 137), 21, 'line 121: scrolled 4 right');
      assert.equal(firstLit(png, 175), 21, 'line 159: still the ISO set');
      assert.equal(firstLit(png, 176), 24, 'CHARSET at line 160: the PETSCII glyph');
      assert.equal(firstLit(png, 215), 24, 'line 199: still the PETSCII glyph');
      assert.equal(firstLit(png, 217), 17, 'line 201: the ISO set, unscrolled');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
