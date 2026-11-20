import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from '../src/mos/index.ts';
import type { BuildOptions, IrProgram } from '../src/mos/index.ts';
import { link } from '../index.mjs';
import { loadCatalog, resolveHardware } from '../../cli/src/hardware.mjs';

const MAIN = 'use self::lib::limit;\npub fn main() {\n    let x: u16 = limit;\n}\n';

test('a reversed directory listing gives the same variant diagnostic', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-determinism-'));
  const realReaddir = fs.readdirSync;
  try {
    for (const name of ['lib.nes.8bs', 'lib.c64.8bs', 'lib.pet.8bs', 'lib.atari8.8bs']) {
      await writeFile(join(dir, name), 'pub let mut limit: u16 = 1;');
    }
    const entry = join(dir, 'main.8bs');
    const messageFor = () => link(MAIN, entry, { machine: 'web' }).diagnostics.map((d: { message: string }) => d.message);

    const forward = mock.method(fs, 'readdirSync', (...args: unknown[]) => (realReaddir as (...a: unknown[]) => string[])(...args).slice().sort());
    syncBuiltinESMExports();
    const a = messageFor();
    forward.mock.restore();

    mock.method(fs, 'readdirSync', (...args: unknown[]) => (realReaddir as (...a: unknown[]) => string[])(...args).slice().sort().reverse());
    syncBuiltinESMExports();
    const b = messageFor();

    assert.equal(a.length, 1);
    assert.match(a[0], /targets: /);
    assert.deepEqual(b, a);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test('two builds in one process give an equal listing', async () => {
  const src = 'let mut n: utinyint = 0;\n\npub fn main() {\n    while n < 10 {\n        n += 1;\n    }\n}\n';
  const resolved = resolveHardware(loadCatalog('pet'), { profile: '3032' });
  assert.ok(resolved.ok, resolved.ok ? '' : resolved.error);
  const linked = link(src, '/virtual/game.8bs', { machine: 'pet', facts: resolved.hardware.facts });
  assert.deepEqual(linked.diagnostics, []);
  const hardware = resolved.hardware as unknown as BuildOptions['hardware'];
  const scratch = await mkdtemp(join(tmpdir(), '8bs-determinism-'));
  try {
    const once = async (name: string) => {
      const outFile = join(scratch, name);
      const result = await build(linked.ir as IrProgram, {
        machine: 'pet', hardware, outFile, frameRate: 60, debug: true, sources: linked.sources,
      });
      assert.equal(result.ok, true, result.ok ? '' : result.error);
      if (!result.ok) throw new Error('unreachable');
      return { listing: result.listing, lst: await readFile(outFile.replace(/\.prg$/, '.lst'), 'utf8') };
    };
    const first = await once('a.prg');
    const second = await once('b.prg');
    assert.ok(first.listing && first.listing.length > 0);
    assert.deepEqual(second.listing, first.listing);
    assert.equal(second.lst, first.lst);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
