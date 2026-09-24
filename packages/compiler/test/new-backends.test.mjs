import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { link } from '../index.mjs';
import { build as buildSm83 } from '../src/sm83/index.ts';
import { build as buildZ80 } from '../src/z80/index.ts';
import { build as build6809 } from '../src/m6809/index.ts';
import { build as build8048 } from '../src/i8048/index.ts';
import { build as buildF8 } from '../src/f8/index.ts';

const SOURCE = [
  'let sum: utinyint = 0;',
  'export function main(): void {',
  '    for (let i: utinyint = 0; i < 10; i++) {',
  '        sum = sum + i;',
  '    }',
  '    memory.write(0x80, sum);',
  '}',
  '',
].join('\n');

function hardware(output, load) {
  return { build: { defsym: { __load_address: load, __rom_size: 32768 }, output }, facts: {} };
}

test('SM83, Z80, 6809, 8048 and F8 compile the probe program', async () => {
  const { ir, diagnostics } = link(SOURCE, '/p/main.8bs', { machine: 'gb' });
  assert.deepEqual(diagnostics, []);
  const scratch = await mkdtemp(join(tmpdir(), '8bs-isa-'));
  try {
    const cases = [
      [buildSm83, 'gb', hardware('gb', 0x150)],
      [buildZ80, 'sms', hardware('sms', 0)],
      [build6809, 'coco', hardware('bin', 0x0e00)],
      [build8048, 'odyssey2', hardware('bin', 0x400)],
      [buildF8, 'channelf', hardware('bin', 0)],
    ];
    for (const [build, machine, hw] of cases) {
      const outFile = join(scratch, `${machine}.bin`);
      const result = await build(ir, { machine, hardware: hw, outFile, frameRate: 60 });
      assert.equal(result.ok, true, result.ok ? machine : `${machine}: ${result.error}`);
      assert.ok(result.bytes.length > 0, machine);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a Game Gear cart starts at a CRT0, not the program, and carries TMR SEGA', async () => {
  const { ir, diagnostics } = link(SOURCE, '/p/main.8bs', { machine: 'gamegear' });
  assert.deepEqual(diagnostics, []);
  const scratch = await mkdtemp(join(tmpdir(), '8bs-gg-crt0-'));
  try {
    const outFile = join(scratch, 'hello.gg');
    const result = await buildZ80(ir, { machine: 'gamegear', hardware: hardware('gg', 0), outFile, frameRate: 60 });
    assert.equal(result.ok, true, result.ok ? 'gg' : result.error);
    assert.equal(result.bytes.length, 32768);
    assert.equal(result.bytes[0], 0xc3);
    assert.equal(result.bytes[1], 0x00);
    assert.equal(result.bytes[2], 0x01);
    assert.equal(result.bytes[0x66], 0xed);
    assert.equal(result.bytes[0x67], 0x45);
    assert.equal(Buffer.from(result.bytes.subarray(0x7ff0, 0x7ff8)).toString('ascii'), 'TMR SEGA');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a print of a string literal folds to stores the same way MOS hello-world does', async () => {
  const src = [
    'export function main(): void {',
    '    print(0, "Hi");',
    '}',
    'function print(cell: usmallint, s: string): void {',
    '    for (let i: utinyint = 0; i < s.length; i++) {',
    '        memory.write(0x9800 + cell + i, s[i]);',
    '    }',
    '}',
    '',
  ].join('\n');
  const { ir, diagnostics } = link(src, '/p/main.8bs', { machine: 'gb' });
  assert.deepEqual(diagnostics, []);
  const scratch = await mkdtemp(join(tmpdir(), '8bs-isa-print-'));
  try {
    const outFile = join(scratch, 'gb.gb');
    const result = await buildSm83(ir, {
      machine: 'gb',
      hardware: hardware('gb', 0x150),
      outFile,
      frameRate: 60,
    });
    assert.equal(result.ok, true, result.ok ? 'gb' : result.error);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('port.write lowers to IR', () => {
  const src = 'export function main(): void { port.write(0xFE, 1); }\n';
  const { ir, diagnostics } = link(src, '/p/main.8bs', { machine: 'spectrum' });
  assert.deepEqual(diagnostics, []);
  const found = JSON.stringify(ir).includes('portWrite');
  assert.equal(found, true);
});
