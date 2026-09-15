// @8bitscript/raster resolves to a machine's own ./rasterline on every
// target: the C64's slot-to-register translation onto its address list,
// the web's direct list in the agreement page, and an honest zero-answer
// stub everywhere else. Pinned here is the capability rule
// packages/input/AGENTS.md states: a portable program naming the
// capability links clean on all nine machines whether or not the machine
// can answer, and #fact(video.raster) — true on the C64 and the web —
// folds the program's raster branch to a constant, so the branch costs a
// machine without the capability nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { link } from '../index.mjs';
import { build } from '../src/mos/index.ts';
import { loadCatalog, resolveHardware, stockFacts } from '../../cli/src/hardware.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// @8bitscript/* resolves through this checkout: the probe entry is not a
// real file and no node_modules on the walk up carries the packages.
const CHECKOUT = join(HERE, '..', '..', '..');

const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];

const PROGRAM = `import { raster, Slot } from "@8bitscript/raster";

const HAS_RASTER: bool = #fact(video.raster);
let added: bool = false;

export function main(): void {
    if (HAS_RASTER) {
        raster.clear();
        added = raster.at(0, Slot.BORDER, 2);
        raster.enable();
    }
    while (true) {
        waitFrame();
    }
}
`;

// The zero-cost half of the promise, measured rather than assumed: on a
// machine without the capability, the guarded program and the same program
// with the import and the branch deleted outright emit the same number of
// bytes — the stub layer and the folded-false branch are pruned away, not
// carried along inert.
const PLAIN = `export function main(): void {
    while (true) {
        waitFrame();
    }
}
`;

const GUARDED = `import { raster, Slot } from "@8bitscript/raster";

const HAS_RASTER: bool = #fact(video.raster);

export function main(): void {
    if (HAS_RASTER) {
        raster.clear();
        raster.at(0, Slot.BORDER, 2);
        raster.enable();
    }
    while (true) {
        waitFrame();
    }
}
`;

test('on a machine without the capability, the guarded raster branch emits the same code size as no import at all', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-rasterline-size-'));
  try {
    for (const machine of ['pet', 'vic20']) {
      const resolved = resolveHardware(loadCatalog(machine), {});
      assert.ok(resolved.ok, resolved.ok ? '' : `${machine}: ${resolved.error}`);
      const sizes = {};
      for (const [name, src] of [['guarded', GUARDED], ['plain', PLAIN]]) {
        const entry = join(HERE, 'rasterline-consumer.8bs');
        const { ir, diagnostics } = link(src, entry, { machine, facts: stockFacts(machine), checkout: CHECKOUT });
        assert.deepEqual(diagnostics, [], `${machine} ${name}`);
        const result = await build(ir, {
          machine, hardware: resolved.hardware, outFile: join(scratch, `${machine}-${name}.out`), frameRate: 60,
        });
        assert.equal(result.ok, true, result.ok ? '' : `${machine} ${name}: ${result.error}`);
        sizes[name] = result.bytes.length;
      }
      assert.equal(sizes.guarded, sizes.plain,
        `${machine}: the guarded raster branch costs ${sizes.guarded - sizes.plain} bytes over no import`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a raster branch behind #fact(video.raster) links clean on all nine machines, its guard a folded constant', () => {
  for (const target of TARGETS) {
    const entry = join(HERE, 'rasterline-consumer.8bs');
    const { ir, diagnostics } = link(PROGRAM, entry, {
      machine: target, facts: stockFacts(target), checkout: CHECKOUT,
    });
    assert.deepEqual(diagnostics, [], target);
    const main = ir.functions.find((f) => f.name === 'main');
    const guard = main.body.find((s) => s.kind === 'if');
    assert.ok(guard, `${target}: the guarded branch is in the IR`);
    assert.equal(guard.test.kind, 'const', `${target}: the guard folded to a constant`);
    assert.equal(Boolean(guard.test.value), target === 'c64' || target === 'web',
      `${target}: video.raster is true on the C64 and the web`);
  }
});
