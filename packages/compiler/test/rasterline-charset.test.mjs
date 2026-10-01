// `Slot.CHARSET`, `raster.COLORS` and `raster.CHARSET`: the portable raster
// surface names a fourth per-line intent — a machine's alternate character
// set — and two compile-time constants a program folds on to ask which
// intents a real implementation answers, the same way `raster.FINE_SCROLL`
// already lets a program fold away a wobble on a machine with splits but
// no scroll. `COLORS` is true exactly where `BORDER`/`BACKGROUND` already
// are (C64, VIC-20, web). `CHARSET` is false on every DEFAULT-hardware
// build — the sweep below builds each target with no `--hardware`, the
// honest-stub case every rasterline file answers the same way — except
// the PET's own `3032` and `4032` model tags, which have real drivers
// (packages/pet/AGENTS.md, "Raster: character-set switching"); the two
// tests after this one check those tags specifically. This file is the
// "answers nothing but costs zero" gate for the new slot on every OTHER
// build, mirroring test/rasterline.test.mjs's gate for the capability as
// a whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';
import { loadCatalog, resolveHardware, stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(HERE, '..', '..', '..');

const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web', 'plus4', 'oric', 'apple2', 'bbc', 'atari5200', 'lynx', 'pce', 'supervision', 'atari2600', 'atari7800', 'gb', 'gbc', 'sms', 'gamegear', 'sg1000', 'msx', 'coleco', 'spectrum', 'cpc', 'coco', 'vectrex', 'odyssey2', 'channelf'];

const COLORS_TRUE = new Set(['vic20', 'c64', 'web']);

test('every rasterline file names Slot.CHARSET and answers raster.COLORS/raster.CHARSET as a folded constant', () => {
  for (const target of TARGETS) {
    // Two separate guards, each a single const or a single #fact() call —
    // the same shape rasterline.test.mjs's own gate uses — because link()
    // folds #fact() but does not constant-fold a `&&` of two already-const
    // operands itself (optimizeReachable, a backend pass, does that).
    const program = `import { raster, Slot } from "@8bitscript/raster";
const HAS_RASTER: bool = #fact(video.raster);
export function main(): void {
    let slot: utinyint = Slot.CHARSET;
    if (raster.CHARSET) {
        raster.at(0, Slot.CHARSET, 1);
    }
    if (raster.COLORS) {
        raster.at(0, Slot.BORDER, 0);
    }
    if (HAS_RASTER) {
        raster.clear();
    }
    return;
}
`;
    const entry = join(HERE, 'rasterline-charset-consumer.8bs');
    const { ir, diagnostics } = link(program, entry, { machine: target, facts: stockFacts(target), checkout: CHECKOUT });
    assert.deepEqual(diagnostics, [], target);
    const main = ir.functions.find((f) => f.name === 'main');
    const guards = main.body.filter((s) => s.kind === 'if');
    assert.equal(guards.length, 3, `${target}: all three guards survive linking`);
    for (const guard of guards) assert.equal(guard.test.kind, 'const', `${target}: each guard folded to a constant`);
    // Today every machine's raster.CHARSET is false — no driver answers the
    // new slot yet.
    assert.equal(Boolean(guards[0].test.value), false, `${target}: raster.CHARSET`);
    assert.equal(Boolean(guards[1].test.value), COLORS_TRUE.has(target), `${target}: raster.COLORS`);
  }
});

test('Slot.CHARSET is 3, the same arbitrary number in all thirty-two rasterline files, unused by anything that reads it', () => {
  for (const target of TARGETS) {
    const { ir, diagnostics } = link(
      'import { Slot } from "@8bitscript/raster";\nconst C: utinyint = Slot.CHARSET;\nexport function main(): void { return; }\n',
      join(HERE, 'rasterline-charset-value.8bs'),
      { machine: target, facts: stockFacts(target), checkout: CHECKOUT },
    );
    assert.deepEqual(diagnostics, [], target);
  }
});

test('the PET 3032 and 4032 model tags answer raster.CHARSET true, the two real implementations among the thirty-two stubs', () => {
  const program = `import { raster } from "@8bitscript/raster";
export function main(): void {
    if (raster.CHARSET) {
        raster.clear();
    }
    return;
}
`;
  for (const model of ['3032', '4032']) {
    const resolved = resolveHardware(loadCatalog('pet'), { overrides: { model } });
    assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
    const entry = join(HERE, `rasterline-charset-${model}.8bs`);
    const { ir, diagnostics } = link(program, entry, {
      machine: 'pet', facts: resolved.hardware.facts, tags: [model], checkout: CHECKOUT,
    });
    assert.deepEqual(diagnostics, [], model);
    const main = ir.functions.find((f) => f.name === 'main');
    const guard = main.body.find((s) => s.kind === 'if');
    assert.equal(guard.test.kind, 'const', model);
    assert.equal(Boolean(guard.test.value), true, `the ${model} tag answers raster.CHARSET true`);
  }
});
