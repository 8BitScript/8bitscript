// Unit tests for the hand-rolled ZIP reader used to pull the .rdf patch out
// of MEGA65's official release archive without an npm zip dependency. Built
// against synthetic ZIPs constructed here (both 'stored' and 'deflate'
// entries) — separately, this reader was confirmed byte-for-byte against the
// real https://files.mega65.org/files/other/920413_Sn7YEw.zip while writing
// it (see rom.mjs's RDF header comment for the corresponding confirmation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { readZipEntries, extractZipEntry, findZipEntry } from '../src/setup/zip.mjs';

/** Build a minimal valid ZIP (local headers + central directory + EOCD)
 * containing the given { name, content, method } entries. method 0 = stored,
 * 8 = deflate. CRC-32 is written as 0 throughout — this reader doesn't check
 * it, matching zip.mjs's own documented scope. */
function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, content, method = 0 } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const compressed = method === 8 ? deflateRawSync(data) : data;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    const localEntry = Buffer.concat([localHeader, nameBuf, compressed]);
    localParts.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(compressed.length, 20);
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
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);

  return Buffer.concat([localSection, centralSection, eocd]);
}

test('readZipEntries + extractZipEntry: a stored (uncompressed) entry round-trips', () => {
  const zip = buildZip([{ name: '920413/920413.rdf', content: 'hello rdf', method: 0 }]);
  const entries = readZipEntries(zip);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, '920413/920413.rdf');
  const data = extractZipEntry(zip, entries[0]);
  assert.equal(data.toString('utf8'), 'hello rdf');
});

test('readZipEntries + extractZipEntry: a deflate-compressed entry round-trips', () => {
  const content = 'the quick brown fox jumps over the lazy dog '.repeat(20);
  const zip = buildZip([{ name: 'patch.rdf', content, method: 8 }]);
  const entries = readZipEntries(zip);
  const data = extractZipEntry(zip, entries[0]);
  assert.equal(data.toString('utf8'), content);
});

test('findZipEntry: matches by exact path, or falls back to basename', () => {
  const zip = buildZip([
    { name: 'README.txt', content: 'readme' },
    { name: '920413/920413.rdf', content: 'rdf bytes' },
  ]);
  const entries = readZipEntries(zip);
  assert.equal(findZipEntry(entries, '920413/920413.rdf').name, '920413/920413.rdf');
  assert.equal(findZipEntry(entries, '920413.rdf').name, '920413/920413.rdf');
  assert.equal(findZipEntry(entries, 'nonexistent.rdf'), null);
});

test('extractZipEntry throws on an unsupported compression method', () => {
  const zip = buildZip([{ name: 'x', content: 'y', method: 0 }]);
  const entries = readZipEntries(zip);
  entries[0].method = 99;
  assert.throws(() => extractZipEntry(zip, entries[0]), /unsupported compression/);
});
