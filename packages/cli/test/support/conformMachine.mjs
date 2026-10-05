// The machine packages' conformance test, written once.
//
// Each of packages/{pet,vic20,c64,cx16}/test/conform.test.mjs calls this with
// what that machine's wasm build is KNOWN to get wrong today. The count only
// goes down: a regression (more cells differ than `knownStructure`) fails, and
// an improvement prints the new number so the table can be tightened. The wasm
// modules are this project's own implementation of each machine and the
// primary way to run a program (docs/project/wasm-primary.md); this is how
// "it mirrors the real device" stays a measurement.
//
// It needs the machine's native emulator, so it lives in the machine packages
// — which `pnpm run test:ci` skips — and skips itself when the emulator is not
// installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conformCommand } from '../../src/conform.mjs';

/**
 * @param {{ machine: string, knownStructure: number, why?: string, program?: string }} spec
 *   `knownStructure`: cells whose glyph differs from the real machine's today
 *   (0 when the wasm build matches). `why` says what they are, for the failure message.
 */
export function conformMachineTest({ machine, knownStructure, why = '', program = 'grid' }) {
  test(`the ${machine} wasm build draws the '${program}' probe like the real ${machine}`, { timeout: 600000 }, async (t) => {
    const out = mkdtempSync(join(tmpdir(), `conform-${machine}-`));
    let keep = false; // a failure leaves the captures and the diff image where its message says
    try {
      await conformCommand([machine, '--program', program, '--out', out], { write: () => {} });
      const report = JSON.parse(readFileSync(join(out, `${program}.json`), 'utf8')).machines[machine];
      if (report.error && /native capture failed/.test(report.error)) {
        t.skip(`no native ${machine} emulator to compare against: ${report.error}`);
        return;
      }
      assert.ok(report.structural !== undefined, `the comparison did not run: ${report.error}`);
      assert.ok(
        report.structural <= knownStructure,
        `${report.structural} cells differ from the real ${machine}; ${knownStructure} is the known gap (${why}). `
        + `This is a regression in the wasm build: see ${out} for the diff image`,
      );
      if (report.structural < knownStructure) {
        t.diagnostic(`improved: ${report.structural} cells differ, down from ${knownStructure}; lower knownStructure in this test`);
      }
    } catch (err) {
      keep = true;
      throw err;
    } finally {
      if (!keep) rmSync(out, { recursive: true, force: true });
    }
  });
}
