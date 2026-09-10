// @8bitscript/c128/vdc — the 80-column chip, and the probe that finds how
// much RAM it has. Three layers, as with ./banks: the probe program links
// clean for the C128 with the stock sheet; the catalog names this subpath
// as what finds the `vdc` option's value at run time; and, when x128 and
// a working backend are installed, it is run on a 16 KiB machine and a
// 64 KiB one and the border color each screenshot shows is what
// vdc.ramKib() found.
//
// The last test is the one that says the chip is really being driven: it
// captures the *VDC's* display (x128 draws two, and `8bs run --screenshot`
// takes the VIC-IIe's) and looks for the "HELLO" the probe wrote into
// 80-column screen RAM while the KERNAL was still running the 40-column
// screen. Both pictures are live at once on this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { loadCatalog, stockFacts } from '../../cli/src/hardware.mjs';
import { pixelAt } from '../../cli/src/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');
const PROBE = join(HERE, 'vdc-probe.8bs');
const PRG = join(ROOT, 'dist', 'vdc-probe-c128-ntsc.prg');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the package exports ./vdc, and the VDC RAM size is found at run time by it', () => {
  assert.equal(pkg['8bitscript'].exports['./vdc'], './src/vdc.8bs');
  const { options } = loadCatalog('c128');
  assert.equal(options.vdc.detect, '@8bitscript/c128/vdc', 'one probe finds both values, so it sits on the option');
});

test('the probe program links clean for the C128, and vdc.ramKib() is a real function in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'c128', facts: stockFacts('c128') });
  assert.deepEqual(diagnostics, []);
  assert.ok(ir.functions.some((f) => f.name === 'vdc_ramKib'));
});

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
const NATIVE_BACKEND_PENDING = 'Bare Metal: waiting on the native backend';

function spawned(command, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: String(err) }); });
  });
}

const runCli = (args, options) => spawned(process.execPath, [CLI_BIN, ...args], options);

test(
  'under x128, vdc.ramKib() finds 16 KiB on a flat C128 and 64 with the bigger chip',
  { skip: NATIVE_BACKEND_PENDING },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-c128-vdc-'));
    try {
      const shots = {};
      for (const [name, hardware] of [['16k', []], ['64k', ['--hardware', 'vdc=64k']]]) {
        const shot = join(scratch, `${name}.png`);
        const { code, stdout, stderr } = await runCli(
          ['run', 'c128', ...hardware, '--screenshot', shot, 'test/vdc-probe.8bs'],
          { timeoutMs: 90_000 },
        );
        assert.equal(code, 0, `8bs run c128 ${hardware.join(' ')} --screenshot failed:\n${stdout}${stderr}`);
        const png = readFileSync(shot);
        shots[name] = { border: pixelAt(png, 4, 4), background: pixelAt(png, 180, 150) };
      }
      // vdc-probe.8bs: a red border for 16 KiB, green for 64.
      const [r, g, b] = shots['16k'].border;
      assert.ok(r > g + 30 && r > b + 30, `16 KiB: a red border, got rgb(${shots['16k'].border})`);
      const [gr, gg, gb] = shots['64k'].border;
      assert.ok(gg > gr + 30 && gg > gb + 30, `64 KiB: a green border, got rgb(${shots['64k'].border})`);
      // And a black background in both: the byte written into VDC RAM read
      // back as itself, so setAddress/put/get round-trips.
      for (const name of ['16k', '64k']) {
        const [br, bg, bb] = shots[name].background;
        assert.ok(br < 60 && bg < 60 && bb < 60, `${name}: the round trip through VDC RAM held (black), got rgb(${shots[name].background})`);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

test(
  'the C128DCR is a 64 KiB VDC at revision 2, and the 80-column screen draws while the KERNAL runs the 40-column one',
  { skip: NATIVE_BACKEND_PENDING },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-c128-vdc2-'));
    try {
      // Build it (the CLI owns the toolchain), then drive x128 by hand: the
      // CLI's --screenshot is the VIC-IIe's display and this needs both.
      const built = await runCli(['run', 'c128', '--screenshot', join(scratch, 'ignored.png'), 'test/vdc-probe.8bs'], { timeoutMs: 90_000 });
      assert.equal(built.code, 0, `build failed:\n${built.stdout}${built.stderr}`);
      assert.ok(existsSync(PRG));

      const vic = join(scratch, 'vic.png');
      const vdc = join(scratch, 'vdc.png');
      await spawned('x128', [
        '-model', 'c128dcr', '-autostartprgmode', '1', '-warp', '-limitcycles', '6000000',
        '-autostart', PRG, '-exitscreenshotvicii', vic, '-exitscreenshot', vdc,
      ], { timeoutMs: 90_000 });
      assert.ok(existsSync(vic) && existsSync(vdc), 'x128 wrote both displays');

      // A C128DCR has the 64 KiB VDC: the probe's green border.
      const [r, g, b] = pixelAt(readFileSync(vic), 4, 4);
      assert.ok(g > r + 30 && g > b + 30, `the DCR's 64 KiB VDC: a green border, got rgb(${[r, g, b]})`);

      // "HELLO" went into 80-column screen RAM at $0000. The VDC's picture
      // is otherwise blank, so any lit pixel in the top-left is the text.
      const shot = readFileSync(vdc);
      let lit = 0;
      for (let y = 20; y < 60; y++) {
        for (let x = 80; x < 200; x++) {
          const [pr, pg, pb] = pixelAt(shot, x, y);
          if (pr + pg + pb > 150) lit++;
        }
      }
      assert.ok(lit > 20, `the VDC display shows the text the probe wrote (${lit} lit pixels)`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
