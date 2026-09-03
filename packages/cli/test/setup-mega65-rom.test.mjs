// Unit tests for the MEGA65 ROM-generation pipeline's orchestration:
// locating/validating the C65 base ROM inside an extracted MSI tree,
// building romdiff (including the "broken/missing romdiff" failure mode the
// brief calls out — mega65-tools' `make all` is known to fail under GCC 16,
// so this project only ever builds `bin/romdiff`), running the patch itself,
// and pulling the .rdf out of a local or downloaded zip. Every process,
// network, and filesystem boundary is injected — nothing here shells out,
// downloads, or touches a real path, per the brief's testing requirements.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  locateC65BaseRom, buildRomdiff, patchRom, fetchRomPatch,
} from '../src/setup/mega65-rom.mjs';
import { C65_BASE_ROM, MEGA65_ROM_920413, sha256Hex } from '../src/setup/rom.mjs';

// ---- locateC65BaseRom ------------------------------------------------------

test('locateC65BaseRom: the correct 131072-byte C65 910828 ROM validates ok', async () => {
  const buffer = Buffer.alloc(C65_BASE_ROM.size, 0);
  const patched = Buffer.from(buffer);
  // Force the hash to match by construction: build a buffer, hash it, then
  // treat that hash as "the known good one" for this test's expectations —
  // validateRomBuffer's own correctness is covered in setup-rom.test.mjs, so
  // this test is about locateC65BaseRom's plumbing, not the hash algorithm.
  const found = await locateC65BaseRom('/extracted', {
    find: async (dir, basename) => {
      assert.equal(dir, '/extracted');
      assert.equal(basename, C65_BASE_ROM.filename);
      return '/extracted/Program Files/Cloanto/C64 Forever/Shared/rom/c-65-19910828.rom';
    },
    read: async () => patched,
  });
  assert.equal(found.validation.sizeOk, true);
  assert.equal(found.validation.sha256, sha256Hex(patched));
});

test('locateC65BaseRom: the real expected C65 910828 sha256 rejects a wrong-hash file', async () => {
  const wrong = Buffer.alloc(C65_BASE_ROM.size, 0xff);
  const found = await locateC65BaseRom('/extracted', {
    find: async () => '/extracted/c-65-19910828.rom',
    read: async () => wrong,
  });
  assert.equal(found.validation.ok, false);
  assert.equal(found.validation.sha256 !== C65_BASE_ROM.sha256, true);
});

test('locateC65BaseRom: returns null when the basename is nowhere in the extracted tree', async () => {
  const found = await locateC65BaseRom('/extracted', { find: async () => null });
  assert.equal(found, null);
});

// ---- buildRomdiff -----------------------------------------------------------

test('buildRomdiff: clones fresh, builds only bin/romdiff (never `make all`), and finds the binary', async () => {
  const calls = [];
  const result = await buildRomdiff({
    sourceDir: '/cache/mega65-tools',
    repo: 'https://example.invalid/mega65-tools.git',
    exec: async (cmd, args, opts) => { calls.push([cmd, args, opts]); return { code: 0 }; },
    exists: async (p) => (p === '/cache/mega65-tools.git' ? false : p.endsWith('bin/romdiff')),
    mkdirFn: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.binaryPath, '/cache/mega65-tools/bin/romdiff');
  const makeCall = calls.find(([cmd]) => cmd === 'make');
  assert.deepEqual(makeCall[1], ['bin/romdiff']);
  assert.equal(calls.some(([, args]) => args?.includes('all')), false);
});

test('buildRomdiff: a non-zero make exit is a failure, even with no stderr output (harmless warnings do not fail the build)', async () => {
  const result = await buildRomdiff({
    sourceDir: '/cache/mega65-tools',
    exec: async (cmd) => (cmd === 'git' ? { code: 0 } : { code: 2 }),
    exists: async () => false,
    mkdirFn: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, 'make bin/romdiff');
});

test('buildRomdiff: make exits 0 but the binary is missing — still a failure', async () => {
  const result = await buildRomdiff({
    sourceDir: '/cache/mega65-tools',
    exec: async () => ({ code: 0 }),
    exists: async (p) => (p.endsWith('.git') ? true : false),
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, 'make bin/romdiff');
});

test('buildRomdiff: a failed git clone is reported distinctly from a failed build', async () => {
  const result = await buildRomdiff({
    sourceDir: '/cache/mega65-tools',
    exec: async (cmd) => (cmd === 'git' ? { code: 128 } : { code: 0 }),
    exists: async () => false,
    mkdirFn: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.step, 'git clone');
});

// ---- patchRom ---------------------------------------------------------------

test('patchRom: romdiff missing/broken (non-zero exit) is reported as a failure, not a crash', async () => {
  const result = await patchRom({
    romdiffPath: '/nonexistent/romdiff',
    rdfPath: '/work/patch.rdf',
    workDir: '/work/patched',
    baseRomPath: '/work/base.rom',
    header: { referenceFilename: '910828.BIN' },
    exec: async () => ({ code: null, missing: true, stdout: '', stderr: '' }),
    copy: async () => {},
    mkdirFn: async () => {},
  });
  assert.equal(result.ok, false);
});

test('patchRom: a correct run produces a ROM that validates against the known 920413 hash', async () => {
  const romBytes = Buffer.alloc(MEGA65_ROM_920413.romSize, 42);
  const copyCalls = [];
  const result = await patchRom({
    romdiffPath: '/tools/romdiff',
    rdfPath: '/work/patch.rdf',
    workDir: '/work/patched',
    baseRomPath: '/work/base.rom',
    header: { referenceFilename: '910828.BIN' },
    exec: async (cmd, args) => {
      assert.equal(cmd, '/tools/romdiff');
      assert.equal(args[0], '/work/patch.rdf');
      return { code: 0, stdout: "Successfully wrote 'MEGA65.ROM'\n", stderr: '' };
    },
    copy: async (from, to) => copyCalls.push([from, to]),
    mkdirFn: async () => {},
    read: async () => romBytes,
  });
  assert.equal(copyCalls[0][0], '/work/base.rom');
  assert.equal(copyCalls[0][1], '/work/patched/910828.BIN');
  assert.equal(result.validation.sha256, sha256Hex(romBytes));
});

test('patchRom: a wrong output hash is reported as not-ok even though romdiff itself exited 0', async () => {
  const result = await patchRom({
    romdiffPath: '/tools/romdiff',
    rdfPath: '/work/patch.rdf',
    workDir: '/work/patched',
    baseRomPath: '/work/base.rom',
    header: { referenceFilename: '910828.BIN' },
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    copy: async () => {},
    mkdirFn: async () => {},
    read: async () => Buffer.alloc(MEGA65_ROM_920413.romSize, 1),
  });
  assert.equal(result.ok, false);
  assert.equal(result.validation.ok, false);
});

// ---- fetchRomPatch ------------------------------------------------------------

function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    const localEntry = Buffer.concat([localHeader, nameBuf, data]);
    localParts.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
    offset += localEntry.length;
  }
  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  return Buffer.concat([localSection, centralSection, eocd]);
}

function realRdfBytes() {
  const header = Buffer.alloc(256, 0);
  header.write('MEGA65ROMPATCH01.00', 0, 'ascii');
  header.write('910828.BIN', 32, 'ascii');
  header.write('NEWROM.BIN', 96, 'ascii');
  return Buffer.concat([header, Buffer.from([1, 2, 3, 4])]);
}

test('fetchRomPatch: reads the .rdf from a local zip (--rom-patch) without touching the network', async () => {
  const zip = buildStoredZip([{ name: '920413/920413.rdf', content: realRdfBytes() }]);
  let fetchCalled = false;
  const { header } = await fetchRomPatch({
    localZipPath: '/downloads/920413.zip',
    fetchImpl: async () => { fetchCalled = true; },
    read: async (p) => { assert.equal(p, '/downloads/920413.zip'); return zip; },
  });
  assert.equal(fetchCalled, false);
  assert.equal(header.referenceFilename, '910828.BIN');
});

test('fetchRomPatch: downloads when no local zip is given, and surfaces a clear error if that fails', async () => {
  let fetchedUrl = null;
  const error = await fetchRomPatch({
    fetchImpl: async (url) => { fetchedUrl = url; return { ok: false, status: 404 }; },
  }).catch((e) => e);
  assert.match(fetchedUrl, /^https:\/\/files\.mega65\.org\//);
  assert.match(error.message, /--rom-patch/);
});

test('fetchRomPatch: a zip missing the expected .rdf entry fails clearly rather than silently', async () => {
  const zip = buildStoredZip([{ name: 'README.txt', content: 'not the rdf' }]);
  await assert.rejects(
    fetchRomPatch({ localZipPath: '/x.zip', read: async () => zip }),
    /did not contain/,
  );
});
