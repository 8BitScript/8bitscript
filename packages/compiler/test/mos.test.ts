import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  build, outputExtension, CPU, reduceRatio, frameRatio, FRAME_SYNC,
} from '../src/mos/index.ts';
import type { Machine, RatioPair } from '../src/mos/index.ts';

const ir = {};

const hardware = { build: { defsym: {} }, facts: {} };

test('build() for the PET writes a 15-byte .prg for an empty program: load address + 12-byte stub + RTS', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const result = await build(ir, { machine: 'pet', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      [...result.bytes],
      [
        0x01, 0x04, // load address $0401, little-endian
        0x0b, 0x04, // BASIC stub: link to $040B
        0x00, 0x00, // line number 0
        0x9e, 0x31, 0x30, 0x33, 0x37, 0x00, // SYS token, "1037", end of line
        0x00, 0x00, // end of program
        0x60, // startup routine: RTS
      ],
    );
    assert.equal(result.bytes.length, 15);
    assert.deepEqual(result.memory, { variables: 0, program: 15 });
    assert.equal(existsSync(outFile), true);
    assert.deepEqual([...await readFile(outFile)], [...result.bytes]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('build() for a parked machine says so, names the machine, and writes nothing', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-6502-native-'));
  try {
    const outFile = join(scratch, 'out.prg');
    const result = await build(ir, { machine: 'c64', hardware, outFile, frameRate: 60 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /not a target in 0\.2\.0/);
    assert.match(result.ok ? '' : result.error, /c64/);
    assert.doesNotMatch(result.ok ? '' : result.error, /not implemented/);
    assert.equal(existsSync(outFile), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('outputExtension: prg everywhere except NES (.nes) and Atari 8-bit (.xex, or hardware.output)', () => {
  assert.equal(outputExtension('vic20'), 'prg');
  assert.equal(outputExtension('nes'), 'nes');
  assert.equal(outputExtension('atari8'), 'xex');
  assert.equal(outputExtension('atari8', { build: { defsym: {}, output: 'rom' }, facts: {} }), 'rom');
});

test('CPU has exactly the eight machine keys; NES has no decimal mode; CX16 has no JMP-indirect page bug', () => {
  const keys = Object.keys(CPU).sort() as Machine[];
  assert.deepEqual(keys, ['atari8', 'c128', 'c64', 'cx16', 'mega65', 'nes', 'pet', 'vic20']);
  assert.equal(CPU.nes.decimalMode, false);
  assert.equal(CPU.cx16.jmpIndirectPageBug, false);
});

test('reduceRatio: the closest p/q with p + q <= 65535, exact when the ratio already fits', () => {
  assert.deepEqual(reduceRatio(50, 60), { num: 5, den: 6, error: 0 });
  const r = reduceRatio(60 * 263 * 65 * 14, 14318181); // c64 NTSC at 60
  assert.deepEqual([r.num, r.den], [23117, 23050]);
  assert.ok(r.num + r.den <= 65535);
  assert.ok(r.error < 1e-8, `relative error ${r.error}`);
});

test('frameRatio: every machine at every ordinary rate fits sixteen bits within a frame a day', () => {
  for (const [machine, sync] of Object.entries(FRAME_SYNC)) {
    if (sync.kind === 'edge' && 'calibrate' in sync) continue; // the PET measures its own, in 32 bits
    for (const frameRate of [30, 50, 60, 100, 120]) {
      const { type, pairs } = frameRatio(sync, frameRate);
      assert.equal(type, 'uint16_t', `${machine} at ${frameRate}`);
      for (const [region, { num, den }] of Object.entries(pairs)) {
        assert.ok(num + den <= 65535, `${machine} ${region} at ${frameRate}: ${num} + ${den}`);
        const exact: RatioPair = sync.kind === 'level'
          ? sync[region as 'ntsc' | 'pal']
          : { num: sync.num, den: sync.den };
        const truth = (frameRate * exact.num) / exact.den;
        const driftPerDay = (Math.abs(num / den - truth) / truth) * frameRate * 86400;
        assert.ok(driftPerDay < 1, `${machine} ${region} at ${frameRate} drifts ${driftPerDay} frames a day`);
      }
    }
  }
});

test('frameRatio: a rate the sixteen-bit form cannot hold accurately falls back to the exact 32-bit pair', () => {
  const { type, pairs } = frameRatio(FRAME_SYNC.c64, 1000);
  assert.equal(type, 'uint32_t');
  assert.deepEqual(pairs.ntsc, { num: 1000 * 263 * 65 * 14, den: 14318181 });
});
