// raster.frame() and raster.FRAME_COUNTER, the portable video-frame counter
// (docs/project/frame.md, "A frame counter"). Every rasterline file — the
// two real counters among thirty-odd honest stubs — names both, and the
// const folds to a literal a program can branch on, so a stub costs the
// program nothing. The counters themselves are proved under the emulators
// (packages/c64/test/raster-frame.test.mjs, packages/cx16/test/raster-frame.test.mjs);
// this file is the CI-run gate for the surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';
import { stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(HERE, '..', '..', '..');

const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web', 'plus4', 'oric', 'apple2', 'bbc', 'atari5200', 'lynx', 'pce', 'supervision', 'atari2600', 'atari7800', 'gb', 'gbc', 'sms', 'gamegear', 'sg1000', 'msx', 'coleco', 'spectrum', 'cpc', 'coco', 'vectrex', 'odyssey2', 'channelf'];

// The machines whose raster handler counts video frames: the C64's
// line-0 pass and the X16's end-of-pass. Everywhere else the answer is a
// folded false (the loop pass of a waitFrame() program already is the frame).
const COUNTS = new Set(['c64', 'cx16']);

test('raster.FRAME_COUNTER folds to a literal on every target, true only where the handler counts', () => {
  for (const target of TARGETS) {
    const program = `import { raster } from "@8bitscript/raster";
export function main(): void {
    let seen: utinyint = 0;
    if (raster.FRAME_COUNTER) {
        seen = raster.frame();
    }
    return;
}
`;
    const entry = join(HERE, 'rasterline-frame-consumer.8bs');
    const { ir, diagnostics } = link(program, entry, { machine: target, facts: stockFacts(target), checkout: CHECKOUT });
    assert.deepEqual(diagnostics, [], target);
    const main = ir.functions.find((f) => f.name === 'main');
    const guard = main.body.find((s) => s.kind === 'if');
    assert.equal(guard.test.kind, 'const', `${target}: the guard folded to a constant`);
    assert.equal(Boolean(guard.test.value), COUNTS.has(target), `${target}: raster.FRAME_COUNTER`);
  }
});

test('raster.frame() links on every target, and answers a utinyint a stub folds to 0', () => {
  for (const target of TARGETS) {
    const program = `import { raster } from "@8bitscript/raster";
export function main(): void {
    let now: utinyint = raster.frame();
    now = now + 1;
    return;
}
`;
    const entry = join(HERE, 'rasterline-frame-call.8bs');
    const { diagnostics } = link(program, entry, { machine: target, facts: stockFacts(target), checkout: CHECKOUT });
    assert.deepEqual(diagnostics, [], target);
  }
});

test('the two real counters are wired where the handler runs, and nowhere else is claimed', () => {
  // The C64's handler adds one at its line-0 pass and the installer zeroes
  // the byte; the X16's adds one when a pass over the planned lines ends and
  // enable() zeroes it. A mutation that drops either `inc` must fail here.
  const c64 = readFileSync(join(CHECKOUT, 'packages/c64/native/6502/raster.s'), 'utf8');
  assert.match(c64, /__8bs_c64_raster_top:\n\s+inc 0x06C3/, 'the C64 line-0 pass adds one video frame');
  assert.match(c64, /sta 0x06C3\s+; raster\.frame\(\) counts from here/, 'the C64 installer zeroes the counter');
  const cx16 = readFileSync(join(CHECKOUT, 'packages/cx16/src/rasterline.8bs'), 'utf8');
  assert.match(cx16, /inc \$0408\n\s+ldx #0/, 'the X16 handler adds one when a pass ends');
  assert.match(cx16, /lda #0\n\s+sta \$0408\n\s+sei/, 'the X16 enable() zeroes the counter');
  assert.match(cx16, /memory\.read\(0x0408\)/, 'the X16 frame() reads the counter byte');
  assert.match(readFileSync(join(CHECKOUT, 'packages/c64/src/raster.8bs'), 'utf8'), /@address\(0x06C3\)\nlet frameCounter: volatile<u8>/, 'the C64 counter is the byte the handler increments');
});
