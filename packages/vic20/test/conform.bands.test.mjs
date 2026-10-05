// The VIC-20's raster bands on the wasm build against xvic: `8bs conform vic20
// --program bands` — docs/project/wasm-primary.md, backlog item 3.
//
// Five BORDER entries at picture lines 24, 56, 88, 120 and 152. The wasm build
// applies an entry at its picture line exactly; the real frame hook lands on
// the same line within the tolerance (measured 0 lines on xvic NTSC, 8K).
// What the wasm build does not reproduce is documented in the package's
// emulator.wasm.limits: the colours of the bands differ in places because
// VICE's palette is not ours (a warning here, not a failure), and until the
// first entry the real border keeps the last frame's final value where the
// wasm picture shows the program's own.
//
// Needs xvic, so it lives here, which `pnpm run test:ci` skips, and skips
// itself when the emulator is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conformCommand } from '../../cli/src/conform.mjs';

const KNOWN_OFFSET = 0; // lines the native bands start from the wasm ones today
const TOLERANCE = 2;

test('the vic20 wasm build puts every raster band on the line the real vic20 does', { timeout: 600000 }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'conform-bands-vic20-'));
  let keep = false;
  try {
    await conformCommand(['vic20', '--program', 'bands', '--band-tolerance', String(TOLERANCE), '--out', out], { write: () => {} });
    const report = JSON.parse(readFileSync(join(out, 'bands.json'), 'utf8')).machines.vic20;
    if (report.error && /native capture failed/.test(report.error)) {
      t.skip(`no native vic20 emulator to compare against: ${report.error}`);
      return;
    }
    assert.ok(report.rows, `the comparison did not run: ${report.error}`);
    assert.equal(report.rows.length, 6, 'six bands: the base and the five entries');
    assert.ok(report.rows.every((r) => r.wasmExact), 'the wasm build starts every band on the line the program named');
    assert.ok(
      report.maxOffset <= TOLERANCE,
      `a band starts ${report.maxOffset} lines from the real machine's; the tolerance is ${TOLERANCE}. See ${out}`,
    );
    if (report.maxOffset < KNOWN_OFFSET) t.diagnostic(`improved: ${report.maxOffset} lines`);
  } catch (err) {
    keep = true;
    throw err;
  } finally {
    if (!keep) rmSync(out, { recursive: true, force: true });
  }
});
