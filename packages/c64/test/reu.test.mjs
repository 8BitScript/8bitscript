// @8bitscript/c64/reu — the first run-time hardware probe. Two layers:
// the probe program links clean for the C64 with the stock sheet (no
// emulator needed), and, when x64sc and the SDK are installed, it is run
// under VICE with no REU and with a 512 KiB one, and the border colour
// each screenshot shows is what reu.detect() found. The border encodes the
// answer (see reu-probe.8bs) so the test reads one pixel, not text.
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
import { loadCatalog, stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');
const PROBE = join(HERE, 'reu-probe.8bs');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the package exports ./reu, and the catalog says the REU is found at run time by it', () => {
  assert.equal(pkg['8bitscript'].exports['./reu'], './src/reu.8bs');
  assert.ok(existsSync(join(ROOT, 'src', 'reu.8bs')));
  const { options } = loadCatalog('c64');
  assert.equal(options.ram.detect, '@8bitscript/c64/reu');
  assert.equal(options.sid.detect, undefined, 'the SID model has no probe yet');
});

test('the probe program links clean for the C64, and reu.detect() is a real function in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'c64', facts: stockFacts('c64') });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const name of ['reu_detect', 'reu_present', 'reu_banks']) assert.ok(names.includes(name), name);
});

// --- Under VICE ---------------------------------------------------------

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}
const HAS_SDK = Boolean(process.env.LLVM_MOS_HOME);

function runCli(args, { timeoutMs = 60_000 } = {}) {
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

/**
 * The colour of one pixel of a PNG: enough of a decoder for what VICE
 * writes (8-bit RGB, RGBA or palette, no interlace). Returns [r, g, b].
 */
function pixelAt(path, x, y) {
  const buf = readFileSync(path);
  assert.ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'a PNG');
  let offset = 8;
  let width = 0; let height = 0; let depth = 0; let colorType = 0; let interlace = 0;
  let palette = null;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  assert.equal(depth, 8, '8-bit PNG'); assert.equal(interlace, 0, 'not interlaced');
  assert.ok(x < width && y < height, 'pixel inside the image');
  const channels = { 2: 3, 3: 1, 6: 4 }[colorType];
  assert.ok(channels, `colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = [];
  let previous = Buffer.alloc(stride);
  for (let row = 0; row <= y; row++) {
    const filter = raw[row * (stride + 1)];
    const line = Buffer.from(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      }
      line[i] = (line[i] + predictor) & 0xff;
    }
    rows.push(line);
    previous = line;
  }
  const line = rows[y];
  if (colorType === 3) {
    const index = line[x];
    return [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]];
  }
  return [line[x * channels], line[x * channels + 1], line[x * channels + 2]];
}

test(
  'under VICE, reu.detect() finds no REU on the stock machine and 512 KiB on one fitted with it',
  { skip: (!HAS_SDK && 'LLVM_MOS_HOME not set') || (!onPath('x64sc') && 'x64sc not on PATH') },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), '8bs-reu-test-'));
    try {
      const shots = {};
      for (const [name, hardware] of [['none', []], ['reu512', ['--hardware', 'ram=reu512']]]) {
        const shot = join(scratch, `${name}.png`);
        const { code, stdout, stderr } = await runCli(['run', 'c64', ...hardware, '--screenshot', shot, 'test/reu-probe.8bs'], { timeoutMs: 90_000 });
        assert.equal(code, 0, `8bs run c64 ${hardware.join(' ')} --screenshot failed:\n${stdout}${stderr}`);
        shots[name] = pixelAt(shot, 4, 4); // well inside the border
      }
      // reu-probe.8bs: red for no REU (VICE's red is a dark red, R well
      // above G and B), blue for 512 KiB (B well above R and G).
      const [nr, ng, nb] = shots.none;
      assert.ok(nr > ng + 40 && nr > nb + 40, `no REU: a red border, got rgb(${shots.none})`);
      const [r, g, b] = shots.reu512;
      assert.ok(b > r + 40 && b > g + 40, `512 KiB: a blue border, got rgb(${shots.reu512})`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
