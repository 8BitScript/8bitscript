// @8bitscript/c64/charset past glyph 31, pinned where CI runs it.
//
// `charset.offset(code)` is where glyph `code`'s eight bytes start. It used
// to be `Video.CHARSET + code * 8` with `code: utinyint`, and a binop
// computes at its operands' own width, so the product wrapped at eight bits
// and every glyph from 32 up was written 256 bytes (32 glyphs) low:
// define(40) landed on glyph 8 and define(200) too. The I/O window
// (bankIoOut/bankIoIn) had a second fault: it cleared CHAREN, which from
// %101 gives %001 where the CPU's writes reach the RAM but its reads see
// the character ROM, so `copy` and `readRow` returned the ROM's glyph.
//
// The machine package's own tests (packages/c64/test/charset.test.mjs) run
// the program under x64sc and read the pixels; machine packages are not run
// by CI (scripts/ci-excluded-packages.mjs), so these check the same two
// facts in the linked IR, which a regression changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, '..', '..', 'c64', 'test', 'charset-probe.8bs');

function linkedProbe() {
  const { ir, diagnostics } = link(readFileSync(PROBE, 'utf8'), PROBE, { machine: 'c64', facts: stockFacts('c64') });
  assert.deepEqual(diagnostics, []);
  return ir;
}

function functionNamed(ir, name) {
  const fn = ir.functions.find((f) => f.name === name);
  assert.ok(fn, `${name} is in the linked IR: ${ir.functions.map((f) => f.name).join(', ')}`);
  return fn;
}

/** Every node under `node`, depth first. */
function nodes(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) nodes(child, found);
  } else if (node && typeof node === 'object') {
    found.push(node);
    for (const value of Object.values(node)) nodes(value, found);
  }
  return found;
}

test('the charset probe links clean for the C64 and reaches every glyph writer', () => {
  const names = linkedProbe().functions.map((f) => f.name);
  for (const fn of ['charset_define', 'charset_copy', 'charset_setRow', 'charset_readRow', 'charset_offset']) {
    assert.ok(names.includes(fn), fn);
  }
});

test('charset.offset widens the glyph code before it scales it: no eight-bit product', () => {
  const offset = functionNamed(linkedProbe(), 'charset_offset');
  const scaling = nodes(offset.body ?? offset).filter((n) => n.kind === 'binop' && (n.operator === '*' || n.operator === '<<'));
  assert.ok(scaling.length > 0, 'the offset still scales the code by 8');
  for (const op of scaling) {
    assert.equal(op.type, 'usmallint', `the scaling is computed at ${op.type}, which wraps for glyph 32 and up`);
    assert.equal(op.left.type, 'usmallint', `its left operand is ${op.left.type}`);
  }
});

test('the I/O window clears LORAM, not CHAREN, so reads under it see RAM and not the character ROM', () => {
  const ir = linkedProbe();
  const constants = (name, operator) => nodes(functionNamed(ir, name).body ?? functionNamed(ir, name))
    .filter((n) => n.kind === 'binop' && n.operator === operator)
    .flatMap((n) => [n.left, n.right])
    .filter((n) => n?.kind === 'const')
    .map((n) => n.value);
  const [out] = constants('bankIoOut', '&');
  const [back] = constants('bankIoIn', '|');
  // Port bits are CHAREN (4), HIRAM (2), LORAM (1); the program runs at %101.
  assert.equal(out & 1, 0, `bankIoOut mask ${out?.toString(2)} clears LORAM (%101 -> %100, RAM everywhere)`);
  assert.equal(out & 4, 4, `and keeps CHAREN: clearing it gives %001, where reads see the character ROM`);
  assert.equal(back, 1, `bankIoIn sets LORAM again (%100 -> %101), got ${back}`);
});
