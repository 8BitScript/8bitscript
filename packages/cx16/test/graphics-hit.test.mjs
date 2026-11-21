// graphics::hit and graphics::hitAny on the X16's own 6502 code, under x16emu. The program is the one
// packages/cli/test/graphics-hit.test.mjs runs as wasm (packages/cli/test/graphics-hit-cases.mjs);
// here it ends by printing every answer byte through the KERNAL's CHROUT as two hex digits, between
// a start line and an end line, and the emulator's -echo option copies that text to stdout. The
// header and the trailer are part of the answers, so a program that stopped early or a misread
// line cannot pass. The emulator never exits on its own: the test kills it once the end line has
// arrived (or after a timeout). Skips without x16emu on PATH, and without a display or xvfb-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ART, LENGTH, PICTURES, expected, image, program } from '../../cli/test/graphics-hit-cases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');
const CHECKOUT = join(ROOT, '..', '..');

function onPath(name) {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}

const GRACE_MS = 3000;
const EMU_TIMEOUT_MS = 120_000;
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

// SIGTERM to the whole group first, so xvfb-run can run its own cleanup and remove its /tmp/.X*-lock
// file, then SIGKILL only what is still alive after a short, bounded wait.
async function stopGroup(pid) {
  try { process.kill(-pid, 'SIGTERM'); } catch { return; }
  for (let waited = 0; waited < GRACE_MS && groupAlive(pid); waited += 50) await sleep(50);
  if (groupAlive(pid)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// The child leads its own process group and the whole group is stopped: xvfb-run leaves the emulator
// and the X server running when only the wrapper dies, and their open pipes would hold the test.
function run(command, args, { cwd, timeoutMs, until } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stopping = null;
    let settled = false;
    const finish = (code, err) => {
      if (settled) return;
      settled = true;
      resolvePromise({ code, stdout, stderr: err ?? stderr, timedOut });
    };
    const stop = () => {
      stopping ??= stopGroup(child.pid);
      return stopping;
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
      if (until && until.test(stdout)) stop();
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => { clearTimeout(timer); stop().then(() => finish(code)); });
    child.on('error', (err) => { clearTimeout(timer); finish(null, String(err)); });
  });
}

// out(c): CHROUT, through a low RAM cell (the asm block is opaque to the compiler, so a value
// crosses it through memory). hex(v): the byte as two digits.
const SHOW = [
  'fn out(c: utinyint) {',
  '    memory::write(0x0400, c);',
  '    asm6502 {',
  '        lda $0400',
  '        jsr $FFD2',
  '    }',
  '}',
  '',
  'fn digit(n: utinyint) {',
  '    if n < 10 {',
  '        out(n + 48);',
  '    } else {',
  '        out(n + 55);',
  '    }',
  '}',
  '',
  'fn show() {',
  '    out(13);',
  '    out(60);', // <
  '    out(60);',
  '    out(60);',
  '    out(13);',
  `    for i: utinyint in 0..${LENGTH} {`,
  '        let v: utinyint = answers[i];',
  '        digit(v / 16);',
  '        digit(v & 15);',
  '        out(32);',
  '    }',
  '    out(13);',
  '    out(62);', // >
  '    out(62);',
  '    out(62);',
  '    out(13);',
  '}',
];

// The stdout of -echo escapes what is not printable ASCII, and the screen editor may break a long
// line, so the answers are the whitespace-separated tokens between the <<< and >>> markers, and every
// token must be exactly two hex digits.
function readBytes(stdout) {
  const start = stdout.lastIndexOf('<<<');
  const end = stdout.indexOf('>>>', start);
  assert.ok(start >= 0 && end > start, `the answers were printed:\n${stdout.slice(-400)}`);
  const tokens = stdout.slice(start + 3, end).split(/\s+/).filter((t) => t !== '');
  const bad = tokens.findIndex((t) => !/^[0-9A-F]{2}$/.test(t));
  assert.equal(bad, -1, `token ${bad} of the readback is not two hex digits: ${JSON.stringify(tokens[bad])}`);
  return tokens.map((t) => parseInt(t, 16));
}

const needsDisplay = !process.env.DISPLAY && !onPath('xvfb-run');
const skipReason = !onPath('x16emu') ? 'x16emu not on PATH'
  : needsDisplay ? 'no DISPLAY and no xvfb-run on PATH: x16emu has no screen to open'
    : false;

test('under x16emu, the X16 build stores the same answers as the wasm builds', { skip: skipReason }, async () => {
  const dir = mkdtempSync(join(HERE, 'gfx-hit-'));
  try {
    for (const { name, w, h, opaque } of PICTURES) writeFileSync(join(dir, `${name}.png`), image(w, h, opaque));
    writeFileSync(join(dir, 'art.8bg'), ART);
    writeFileSync(join(dir, 'probe.8bs'), program({
      extra: SHOW,
      show: 'show();',
    }));
    const built = await run(process.execPath, [CLI_BIN, 'build', '--target', 'cx16', '--checkout', CHECKOUT, 'probe.8bs'], { cwd: dir, timeoutMs: 180_000 });
    assert.equal(built.code, 0, `8bs build --target cx16 failed:\n${built.stdout}${built.stderr}`);
    const prg = join(dir, 'dist', 'probe-cx16.prg');
    assert.ok(existsSync(prg), `the build wrote ${prg}:\n${built.stdout}`);

    const emu = onPath('xvfb-run') && !process.env.DISPLAY ? ['xvfb-run', '-a', 'x16emu'] : ['x16emu'];
    const ran = await run(emu[0], [...emu.slice(1), '-warp', '-echo', '-prg', prg, '-run'], { cwd: dir, timeoutMs: EMU_TIMEOUT_MS, until: />>>/ });
    assert.ok(!ran.timedOut, `x16emu timed out after ${EMU_TIMEOUT_MS} ms before printing the end line; stdout tail:\n${ran.stdout.slice(-400)}`);
    const got = readBytes(ran.stdout);
    const want = expected();
    assert.equal(got.length, want.length, `${want.length} answers, got ${got.length}`);
    assert.deepEqual(got, want, `first difference at byte ${got.findIndex((v, i) => v !== want[i])}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
