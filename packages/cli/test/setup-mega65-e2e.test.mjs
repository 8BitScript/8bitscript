// End-to-end coverage of generateRom() — the C64 Forever MSI -> extracted
// base ROM -> official patch -> romdiff -> installed MEGA65.ROM pipeline —
// with every I/O boundary faked via the `ioOverrides` bag. This is the path
// a purely idempotent live run against an already-complete install never
// exercises (it short-circuits before reaching any of this), so it's worth
// walking end to end here rather than trusting the individual pieces to
// compose correctly on their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateRom } from '../src/setup/mega65.mjs';
import { MEGA65_ROM_920413, C65_BASE_ROM, sha256Hex } from '../src/setup/rom.mjs';

function makeFakeIo(overrides = {}) {
  const romBytes = Buffer.alloc(MEGA65_ROM_920413.romSize, 0x11);
  const calls = { mkdir: [], writeFile: [], extractMsi: [], patchRom: [], cleanup: [] };
  return {
    calls,
    io: {
      workDirPath: '/work/mega65-rom-work',
      exists: async () => true,
      canPromptInteractively: () => false,
      mkdirFn: async (p) => calls.mkdir.push(p),
      writeFileFn: async (p, data) => calls.writeFile.push([p, data]),
      extractMsi: async (msiPath, destDir) => { calls.extractMsi.push([msiPath, destDir]); return { code: 0, missing: false }; },
      locateBaseRom: async () => ({
        path: '/work/mega65-rom-work/c64forever/c-65-19910828.rom',
        validation: { ok: true, size: C65_BASE_ROM.size, sha256: C65_BASE_ROM.sha256 },
      }),
      fetchPatch: async () => ({ rdfBytes: Buffer.from('rdf'), header: { referenceFilename: '910828.BIN' } }),
      buildRomdiffFn: async () => ({ ok: true, binaryPath: '/tools/romdiff' }),
      patchRomFn: async (args) => {
        calls.patchRom.push(args);
        return { ok: true, buffer: romBytes, validation: { ok: true, sha256: sha256Hex(romBytes) } };
      },
      cleanup: async (dir) => calls.cleanup.push(dir),
      ...overrides,
    },
  };
}

test('generateRom: full happy path — MSI through installed canonical ROM, work dir always cleaned up', async () => {
  const { io, calls } = makeFakeIo();
  const sudoCalls = [];
  const sudoExec = async (cmd, args) => { sudoCalls.push([cmd, args]); return { code: 0 }; };

  const result = await generateRom(
    { c64ForeverPath: '/downloads/c64-forever-11-setup.msi' },
    sudoExec,
    async () => { throw new Error('should not fetch over the network — fetchPatch is faked'); },
    io,
  );

  assert.equal(result.ok, true);
  assert.equal(result.detail, MEGA65_ROM_920413.release);

  assert.equal(calls.extractMsi.length, 1);
  assert.equal(calls.extractMsi[0][0], '/downloads/c64-forever-11-setup.msi');

  assert.equal(calls.patchRom[0].baseRomPath, '/work/mega65-rom-work/c64forever/c-65-19910828.rom');
  assert.equal(calls.patchRom[0].header.referenceFilename, '910828.BIN');

  // Canonical install: sudo mkdir /opt/mega65, then sudo install into it.
  assert.deepEqual(sudoCalls[0], ['mkdir', ['-p', '/opt/mega65']]);
  assert.equal(sudoCalls[1][0], 'install');
  assert.equal(sudoCalls[1][1][2], '/opt/mega65/MEGA65.ROM');

  // Cleanup always runs, on the success path too.
  assert.deepEqual(calls.cleanup, ['/work/mega65-rom-work']);
});

test('generateRom: no C64 Forever MSI given, non-interactive — fails clearly instead of hanging on a prompt', async () => {
  const { io } = makeFakeIo({ canPromptInteractively: () => false });
  const result = await generateRom({}, async () => ({ code: 0 }), async () => {}, io);
  assert.equal(result.ok, false);
  assert.match(result.detail, /--c64-forever/);
});

test('generateRom: MSI path given but the file does not exist', async () => {
  const { io } = makeFakeIo({ exists: async () => false });
  const result = await generateRom(
    { c64ForeverPath: '/nope.msi' }, async () => ({ code: 0 }), async () => {}, io,
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /not found/);
});

test('generateRom: msiextract missing — reported distinctly, and the work dir is still cleaned up', async () => {
  const { io, calls } = makeFakeIo({
    extractMsi: async () => ({ code: null, missing: true }),
  });
  const result = await generateRom(
    { c64ForeverPath: '/x.msi' }, async () => ({ code: 0 }), async () => {}, io,
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /msitools/);
  assert.deepEqual(calls.cleanup, ['/work/mega65-rom-work']);
});

test('generateRom: wrong C65 base ROM hash inside the MSI stops before touching the network for the patch', async () => {
  let fetchPatchCalled = false;
  const { io } = makeFakeIo({
    locateBaseRom: async () => ({
      path: '/x/c-65-19910828.rom',
      validation: { ok: false, size: C65_BASE_ROM.size, sha256: 'deadbeef'.repeat(8) },
    }),
    fetchPatch: async () => { fetchPatchCalled = true; return {}; },
  });
  const result = await generateRom(
    { c64ForeverPath: '/x.msi' }, async () => ({ code: 0 }), async () => {}, io,
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /does not match the expected C65 910828 ROM/);
  assert.equal(fetchPatchCalled, false);
});

test('generateRom: romdiff build failure (broken/missing romdiff) stops the pipeline, still cleans up', async () => {
  const { io, calls } = makeFakeIo({
    buildRomdiffFn: async () => ({ ok: false, step: 'make bin/romdiff', code: 2 }),
  });
  const result = await generateRom(
    { c64ForeverPath: '/x.msi' }, async () => ({ code: 0 }), async () => {}, io,
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /romdiff/);
  assert.deepEqual(calls.cleanup, ['/work/mega65-rom-work']);
});

test('generateRom: a failed sudo install is surfaced, and the work dir is still cleaned up (never left with ROM bytes behind)', async () => {
  const { io, calls } = makeFakeIo();
  const result = await generateRom(
    { c64ForeverPath: '/x.msi' },
    async (cmd) => ({ code: cmd === 'install' ? 1 : 0 }),
    async () => {},
    io,
  );
  assert.equal(result.ok, false);
  assert.match(result.detail, /sudo install/);
  assert.deepEqual(calls.cleanup, ['/work/mega65-rom-work']);
});

test('generateRom: --rom-patch supplies the patch locally, without an actual network fetchImpl ever being called', async () => {
  const { io } = makeFakeIo();
  let fetchPatchArgs = null;
  io.fetchPatch = async (args) => { fetchPatchArgs = args; return { rdfBytes: Buffer.from('x'), header: { referenceFilename: '910828.BIN' } }; };
  const result = await generateRom(
    { c64ForeverPath: '/x.msi', romPatchPath: '/downloads/920413.zip' },
    async () => ({ code: 0 }),
    async () => { throw new Error('network fetch should never be reached'); },
    io,
  );
  assert.equal(result.ok, true);
  assert.equal(fetchPatchArgs.localZipPath, '/downloads/920413.zip');
});
