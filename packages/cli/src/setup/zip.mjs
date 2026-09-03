// A minimal ZIP reader, just enough to pull one named entry out of the
// official MEGA65 ROM-patch archive (or a C64 Forever MSI's own zip-shaped
// internals, if ever needed) without adding a zip library dependency this
// project doesn't otherwise need. Supports the two compression methods a
// real-world zip actually uses: 0 (stored) and 8 (deflate, via Node's own
// zlib). Confirmed directly against the real 920413_Sn7YEw.zip from
// files.mega65.org, whose three entries are all stored (method 0) — deflate
// support is here so a future re-upload that does compress them still works.
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** Find the End Of Central Directory record by scanning backward from the
 * end of the file — it can be followed by a variable-length comment, so its
 * offset isn't fixed. */
function findEndOfCentralDirectory(buffer) {
  const maxCommentLength = 65535;
  const searchStart = Math.max(0, buffer.length - 22 - maxCommentLength);
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/** List every entry in a ZIP archive: { name, method, compressedSize,
 * uncompressedSize, localHeaderOffset }. Throws if `buffer` isn't a ZIP
 * this reader understands. */
export function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === -1) throw new Error('not a ZIP file (no end-of-central-directory record found)');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralDirOffset = buffer.readUInt32LE(eocd + 16);

  const entries = [];
  let offset = centralDirOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`ZIP central directory entry ${i} has a bad signature`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decompressed bytes for one entry from `readZipEntries`. */
export function extractZipEntry(buffer, entry) {
  const localNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const localExtraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataOffset = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new Error(`ZIP entry '${entry.name}' uses unsupported compression method ${entry.method}`);
}

/** Find an entry by exact path, or by basename if no exact match — the
 * official archive nests entries under a release-number directory
 * (`920413/920413.rdf`) that this project should not assume is permanent. */
export function findZipEntry(entries, name) {
  const exact = entries.find((e) => e.name === name);
  if (exact) return exact;
  return entries.find((e) => e.name.split('/').pop() === name) ?? null;
}
