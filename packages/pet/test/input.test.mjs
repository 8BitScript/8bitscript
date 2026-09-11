// @8bitscript/pet/input — the PET's keyboard behind the portable input
// surface. Two layers here: the probe links clean for the PET with every
// answer reachable in the IR; and the source holds the shape of the
// phantom-release fix — edges detected on the PHYSICAL cursor keys, with
// SHIFT sampled only afterward to decide what a cursor key's own edge
// means. The regression this pins down was measured under xpet with
// synthetic keys (2026-09-11): releasing SHIFT one or two frames before
// the cursor key — every human release — left frames of bare cursor key
// that the old direction-bit edge detection read as a brand-new
// RIGHT/DOWN press, so every LEFT move in the 2048 game was chased by a
// phantom RIGHT move that slid the board straight back. The behavioral
// proof needs key injection no CI emulator run can do (VICE has no
// matrix-level input scripting), so the manual VICE verification is
// recorded in the source's own header and this test locks the structure
// that makes it true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../../compiler/index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROBE = join(HERE, 'input-probe.8bs');
const SOURCE = readFileSync(join(ROOT, 'src', 'input.8bs'), 'utf8');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the package exports ./input', () => {
  assert.equal(pkg['8bitscript'].exports['./input'], './src/input.8bs');
  assert.ok(existsSync(join(ROOT, 'src', 'input.8bs')));
});

test('the probe links clean for the PET, and every answer is a real function in the IR', () => {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'pet', facts: stockFacts('pet') });
  assert.deepEqual(diagnostics, []);
  const names = ir.functions.map((f) => f.name);
  for (const name of ['input_begin', 'input_poll', 'input_left', 'input_right', 'input_up', 'input_down', 'input_confirm', 'input_cancel']) {
    assert.ok(names.includes(name), name);
  }
});

test('poll() edge-detects the physical keys BEFORE it ever reads SHIFT — the shape that makes a shift release unable to mint a phantom direction edge', () => {
  const body = SOURCE.slice(SOURCE.indexOf('function poll'), SOURCE.indexOf('function left'));
  const newKeysAt = body.indexOf('newKeys');
  const shiftAt = body.indexOf('SHIFT_LEFT');
  assert.ok(newKeysAt !== -1, 'poll() computes newKeys, the fresh physical-key edges');
  assert.ok(shiftAt !== -1, 'poll() still reads SHIFT — to direct a cursor edge, not to gate it');
  assert.ok(newKeysAt < shiftAt, 'the physical edge set is decided before SHIFT is consulted: SHIFT can direct an edge but never create or destroy one');
  // The old, measured-wrong shape composed direction bits from
  // shift-AND-cursor levels and edge-detected THOSE — its signature was a
  // `held` level snapshot carried between frames. The physical snapshot
  // that replaced it is `keysBefore`.
  assert.match(body, /keys & \(keysBefore \^ 0xFF\)/, 'edges come from the physical-key snapshot');
  assert.doesNotMatch(body, /began = held/, 'no direction-level edge detection remains');
});
