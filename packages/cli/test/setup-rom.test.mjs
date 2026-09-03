// Unit tests for the pure/testable core of MEGA65 ROM handling:
// size+hash validation, the .rdf patch header format (confirmed byte-for-byte
// against the real 920413.rdf from files.mega65.org — see rom.mjs's own
// comment), and the Xemu-local-ROM-link decision matrix that "never
// overwrite an unrelated ROM without confirmation" hinges on. No network, no
// sudo — link tests use a real temp directory (cheap, local, non-privileged),
// the same style doctor.test.mjs's findLocalBin test already uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  C65_BASE_ROM, MEGA65_ROM_920413, sha256Hex, validateRomBuffer, parseRdfHeader,
  classifyXemuRomLink, inspectXemuRomLink, ensureXemuRomLink,
} from '../src/setup/rom.mjs';

test('validateRomBuffer: a correct C65 910828 base ROM (right size and hash) validates', () => {
  // Real base ROMs are 128KB of copyrighted Commodore data this project must
  // never embed — a buffer whose sha256 happens to equal the known hash
  // stands in for "the real file", which is all validateRomBuffer checks.
  const buffer = Buffer.alloc(C65_BASE_ROM.size, 0);
  const expected = { size: C65_BASE_ROM.size, sha256: sha256Hex(buffer) };
  const result = validateRomBuffer(buffer, expected);
  assert.equal(result.ok, true);
  assert.equal(result.sizeOk, true);
  assert.equal(result.hashOk, true);
});

test('validateRomBuffer: wrong hash (right size) fails, with the mismatch reported', () => {
  const buffer = Buffer.alloc(C65_BASE_ROM.size, 1);
  const result = validateRomBuffer(buffer, C65_BASE_ROM);
  assert.equal(result.ok, false);
  assert.equal(result.sizeOk, true);
  assert.equal(result.hashOk, false);
});

test('validateRomBuffer: wrong size fails even if truncated content happens to hash-collide trivially', () => {
  const buffer = Buffer.alloc(64, 0);
  const result = validateRomBuffer(buffer, C65_BASE_ROM);
  assert.equal(result.ok, false);
  assert.equal(result.sizeOk, false);
});

test('validateRomBuffer: a correct generated MEGA65 920413 ROM validates', () => {
  const buffer = Buffer.alloc(MEGA65_ROM_920413.romSize, 7);
  const expected = { size: MEGA65_ROM_920413.romSize, sha256: sha256Hex(buffer) };
  assert.equal(validateRomBuffer(buffer, expected).ok, true);
});

// The exact byte layout below (256-byte header: 32-byte magic @0, 64-byte
// reference filename @0x20, 160-byte output filename @0x60) is confirmed
// against both the real 920413.rdf and MEGA65/mega65-tools' own romdiff.c
// source (header[0]/header[32]/header[32+64]) — not guessed.
function buildRdfHeader({ magic = 'MEGA65ROMPATCH01.00', reference = '910828.BIN', output = 'NEWROM.BIN' } = {}) {
  const header = Buffer.alloc(256, 0);
  header.write(magic, 0, 'ascii');
  header.write(reference, 32, 'ascii');
  header.write(output, 96, 'ascii');
  return Buffer.concat([header, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
}

test('parseRdfHeader reads the magic, reference ROM filename, and output filename', () => {
  const header = parseRdfHeader(buildRdfHeader());
  assert.deepEqual(header, {
    magic: 'MEGA65ROMPATCH01.00',
    referenceFilename: '910828.BIN',
    outputFilename: 'NEWROM.BIN',
  });
});

test('parseRdfHeader does not hardcode the 920413 filenames — a different release header parses too', () => {
  const header = parseRdfHeader(buildRdfHeader({ reference: 'C65-SOMEOTHER.BIN', output: 'MEGA65-2.ROM' }));
  assert.equal(header.referenceFilename, 'C65-SOMEOTHER.BIN');
  assert.equal(header.outputFilename, 'MEGA65-2.ROM');
});

test('parseRdfHeader rejects a file that is not a MEGA65 ROM diff (wrong magic, or too short)', () => {
  assert.equal(parseRdfHeader(buildRdfHeader({ magic: 'SOMETHING ELSE' })), null);
  assert.equal(parseRdfHeader(Buffer.alloc(10)), null);
});

test('classifyXemuRomLink: pure decision matrix', () => {
  assert.equal(classifyXemuRomLink({ exists: false }), 'absent');
  assert.equal(classifyXemuRomLink({
    exists: true, isSymlink: true, resolvedTarget: '/opt/mega65/MEGA65.ROM', canonicalPath: '/opt/mega65/MEGA65.ROM',
  }), 'linked');
  assert.equal(classifyXemuRomLink({
    exists: true, isSymlink: true, resolvedTarget: '/some/other/rom', canonicalPath: '/opt/mega65/MEGA65.ROM',
  }), 'foreign');
  assert.equal(classifyXemuRomLink({ exists: true, isSymlink: false, isValidRom: true }), 'migratable');
  assert.equal(classifyXemuRomLink({ exists: true, isSymlink: false, isValidRom: false }), 'foreign');
});

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), '8bs-setup-rom-'));
}

test('inspectXemuRomLink: a valid canonical ROM already linked from the Xemu path', () => {
  const dir = makeTmpDir();
  try {
    const canonical = join(dir, 'MEGA65.ROM');
    const linkPath = join(dir, 'xemu-mega65-rom');
    const romBytes = Buffer.alloc(MEGA65_ROM_920413.romSize, 5);
    writeFileSync(canonical, romBytes);
    symlinkSync(canonical, linkPath);
    const inspection = inspectXemuRomLink(linkPath, canonical, {
      romSize: MEGA65_ROM_920413.romSize, romSha256: sha256Hex(romBytes),
    });
    assert.equal(inspection.state, 'linked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectXemuRomLink: an existing valid Xemu-local ROM, not yet linked, is migratable — never touched as foreign', () => {
  const dir = makeTmpDir();
  try {
    const canonical = join(dir, 'opt', 'MEGA65.ROM');
    const linkPath = join(dir, 'MEGA65.ROM');
    const romBytes = Buffer.alloc(MEGA65_ROM_920413.romSize, 9);
    writeFileSync(linkPath, romBytes);
    const expected = { romSize: MEGA65_ROM_920413.romSize, romSha256: sha256Hex(romBytes) };
    const inspection = inspectXemuRomLink(linkPath, canonical, expected);
    assert.equal(inspection.state, 'migratable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectXemuRomLink: a relative symlink resolves against the link\'s own directory, not the link path itself', () => {
  const dir = makeTmpDir();
  try {
    const canonical = join(dir, 'MEGA65.ROM');
    writeFileSync(canonical, Buffer.alloc(MEGA65_ROM_920413.romSize, 1));
    const linkPath = join(dir, 'xemu-lgb', 'MEGA65.ROM');
    mkdirSync(join(dir, 'xemu-lgb'));
    // A relative target, as a hand-made symlink might use: '../MEGA65.ROM'
    // from xemu-lgb/ resolves to dir/MEGA65.ROM — the canonical path.
    symlinkSync('../MEGA65.ROM', linkPath);
    const inspection = inspectXemuRomLink(linkPath, canonical, MEGA65_ROM_920413);
    assert.equal(inspection.resolvedTarget, canonical);
    assert.equal(inspection.state, 'linked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectXemuRomLink: an unrelated file at the Xemu ROM path is foreign, never migratable', () => {
  const dir = makeTmpDir();
  try {
    const canonical = join(dir, 'opt', 'MEGA65.ROM');
    const linkPath = join(dir, 'MEGA65.ROM');
    writeFileSync(linkPath, 'not a rom, someone else put this here');
    const inspection = inspectXemuRomLink(linkPath, canonical, MEGA65_ROM_920413);
    assert.equal(inspection.state, 'foreign');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureXemuRomLink: never writes to a foreign file, with or without allowMigrate', async () => {
  const dir = makeTmpDir();
  try {
    const canonical = join(dir, 'opt', 'MEGA65.ROM');
    const linkPath = join(dir, 'MEGA65.ROM');
    writeFileSync(linkPath, 'unrelated content the user put here');
    const before = writeSnapshot(linkPath);

    const result = await ensureXemuRomLink(linkPath, canonical, { allowMigrate: true, expected: MEGA65_ROM_920413 });

    assert.equal(result.action, 'skipped-foreign');
    assert.deepEqual(writeSnapshot(linkPath), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureXemuRomLink: a migratable ROM is only replaced with a symlink when allowMigrate is true', async () => {
  const dir = makeTmpDir();
  try {
    const canonical = join(dir, 'opt', 'MEGA65.ROM');
    mkdirSync(join(dir, 'opt'));
    const romBytes = Buffer.alloc(MEGA65_ROM_920413.romSize, 3);
    writeFileSync(canonical, romBytes);
    const linkPath = join(dir, 'MEGA65.ROM');
    writeFileSync(linkPath, romBytes);
    const expected = { romSize: MEGA65_ROM_920413.romSize, romSha256: sha256Hex(romBytes) };

    const declined = await ensureXemuRomLink(linkPath, canonical, { allowMigrate: false, expected });
    assert.equal(declined.action, 'skipped-migratable');

    const migrated = await ensureXemuRomLink(linkPath, canonical, { allowMigrate: true, expected });
    assert.equal(migrated.action, 'migrated');
    const after = inspectXemuRomLink(linkPath, canonical, expected);
    assert.equal(after.state, 'linked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureXemuRomLink: creates the link (and its parent dir) when nothing is there yet', async () => {
  const dir = makeTmpDir();
  try {
    const canonical = join(dir, 'opt', 'MEGA65.ROM');
    const linkPath = join(dir, 'nested', 'xemu-lgb', 'MEGA65.ROM');
    const result = await ensureXemuRomLink(linkPath, canonical, {});
    assert.equal(result.action, 'linked');
    const after = inspectXemuRomLink(linkPath, canonical, MEGA65_ROM_920413);
    assert.equal(after.state, 'linked');
    assert.equal(after.resolvedTarget, canonical);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeSnapshot(path) {
  const stat = lstatSync(path);
  return { isSymlink: stat.isSymbolicLink(), content: stat.isSymbolicLink() ? null : readFileSync(path, 'utf8') };
}
