// A 2-byte-element array of more than 128 elements, read and written under
// x64sc: the C64 twin of packages/pet/test/array-wide.test.mjs. The 6502
// backend used to double the index in A (ASL) and hand it to Y, dropping the
// carry, so element 128 and up landed 256 bytes short (element 185 on
// element 57). The probe lives in packages/compiler/test/fixtures/
// wide-array-probe.mjs and lights one screen cell per passing check;
// packages/compiler/src/mos/lower/index.test.ts pins the emitted code in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pixelAt } from '../../cli/src/png.mjs';
import { BYTES, BYTES_AT, RING_AT, SPECIAL, SPECIAL_AT, TABLE_AT, WIDE, widePointerProbe } from '../../compiler/test/fixtures/wide-array-probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLI_BIN = join(ROOT, '..', 'cli', 'bin', '8bs.mjs');

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

// x64sc's NTSC screenshot: text cell (row, column) starts at PNG pixel
// (32 + 8 * column, 23 + 8 * row). A reverse-video space shows the ink
// (light blue); a blank cell shows the paper (blue, whose red is about 53).
const lit = (png, cell) => pixelAt(png, 32 + (cell % 40) * 8 + 4, 23 + Math.floor(cell / 40) * 8 + 4)[0] > 85;

test(`a ${WIDE}-element usmallint array and a ${BYTES}-element byte array read back exactly on the C64`, { skip: !onPath('x64sc'), timeout: 240_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-c64-array-wide-'));
  try {
    const file = join(scratch, 'wide.8bs');
    writeFileSync(file, widePointerProbe(0x0400));
    const shot = join(scratch, 'wide.png');
    const { code, stdout, stderr } = await runCli(['run', 'c64', '--screenshot', shot, file]);
    assert.equal(code, 0, `8bs run c64 --screenshot failed:\n${stdout}${stderr}`);
    const png = readFileSync(shot);
    const wrong = [];
    for (let i = 0; i < WIDE; i += 1) if (!lit(png, RING_AT + i)) wrong.push(`ring[${i}]`);
    for (let i = 0; i < WIDE; i += 1) if (!lit(png, TABLE_AT + i)) wrong.push(`TABLE[${i}]`);
    for (let i = 0; i < BYTES; i += 1) if (!lit(png, BYTES_AT + i)) wrong.push(`bytes[${i}]`);
    SPECIAL.forEach((name, i) => { if (!lit(png, SPECIAL_AT + i)) wrong.push(name); });
    assert.deepEqual(wrong, [], `${wrong.length} wrong, first: ${wrong.slice(0, 8).join(', ')}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
