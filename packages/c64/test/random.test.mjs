// @8bitscript/c64/random — SID voice 3's hardware entropy. Checked without
// an emulator: the package exports it, and the probe links clean with
// every call reaching the IR. A live-under-VICE check (does $D41B actually
// change between two reads, the way reu.test.mjs and layers.test.mjs check
// other C64 hardware by screenshot) is the natural follow-up and is left
// for whoever adds it — nothing here claims the noise generator was
// checked against real SID silicon or VICE's emulation of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROBE = join(HERE, 'random-probe.8bs');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the package exports ./random, and it is not part of ./sid', () => {
  assert.equal(pkg['8bitscript'].exports['./random'], './src/random.8bs');
  assert.ok(existsSync(join(ROOT, 'src', 'random.8bs')));
  const sid = readFileSync(join(ROOT, 'src', 'sid.8bs'), 'utf8');
  assert.doesNotMatch(sid, /voice3Oscillator|voice3Envelope/, 'entropy stays out of the sound package, like atari8/random does');
});

test('the probe links clean for the C64, and every call is a real function in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'c64', facts: stockFacts('c64') });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const name of ['random_begin', 'random_byte', 'random_word']) {
    assert.ok(names.includes(name), name);
  }
});

test('begin() sets a whole known $D418 rather than reading a write-only register back', () => {
  // The header explains why: $D419 and below cannot be trusted to read
  // back what was last written, so a read-modify-write there would be
  // building on a value the chip never promised. This is the one line most
  // likely to regress into `sidRegisters[24] = sidRegisters[24] | 0x80`,
  // which looks more careful and is actually wrong.
  const source = readFileSync(join(ROOT, 'src', 'random.8bs'), 'utf8');
  const body = source.split('function begin')[1];
  assert.match(body, /sidRegisters\[24\] = 0x80;/, 'begin() must assign $D418 outright, not merge into a read');
  assert.doesNotMatch(body, /sidRegisters\[24\]\s*\|/, 'no read-modify-write of the write-only $D418');
});
