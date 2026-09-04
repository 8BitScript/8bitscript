// MEGA65 ROM handling: validating the legally-obtained C65 base ROM and the
// official 920413 patch's own byte format, and deciding how the canonical
// ROM should relate to Xemu's per-user data directory — all pure/testable,
// no filesystem or network access. The one filesystem-touching helper at the
// bottom (`inspectXemuRomLink`) is a thin real-fs wrapper around the pure
// `classifyXemuRomLink` below it, kept here so doctor.mjs and setup/mega65.mjs
// share one implementation of "is this symlink already correct".
//
// 8BitScript never bundles or downloads the ROM itself — see docs/setup/
// mega65.md. What lives here only checks a ROM the *user* already has.
import { createHash } from 'node:crypto';
import {
  lstat as fsLstat, readlink as fsReadlink, readFile as fsReadFile,
  mkdir as fsMkdir, symlink as fsSymlink, unlink as fsUnlink,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// The free C65 910828 ROM from Cloanto's "C64 Forever Free Express Edition",
// which the official MEGA65 920413 patch is diffed against. Confirmed size
// and hash from a working install (see the setup brief this module
// implements) — this is the gate that stops a wrong/corrupt base ROM from
// silently producing a bad MEGA65.ROM.
export const C65_BASE_ROM = {
  filename: 'c-65-19910828.rom',
  size: 131072,
  sha256: '0c4a00b45b65ca553b8a9f38cae83fe5f7dca7e809c24c0051ae40956640509d',
};

// The official MEGA65 920413 ROM release. `patchUrl` carries a suffix
// (`_Sn7YEw`) that looks like a content hash or random token MEGA65's file
// host generated for this specific upload — nothing says it is stable across
// future releases or re-uploads of this same release, so treat it as a
// best-effort default, not a permanent API. `romSha256` is the value that
// actually matters: it's checked against the *generated* MEGA65.ROM, which
// stays correct even if this URL goes stale (setup's --rom-patch flag is the
// escape hatch for that case — see setup/mega65.mjs).
export const MEGA65_ROM_920413 = {
  release: '920413',
  patchUrl: 'https://files.mega65.org/files/other/920413_Sn7YEw.zip',
  rdfEntryName: '920413.rdf',
  romSize: 131072,
  romSha256: 'af3c447f791a2fdc48cb21e1bd3fab015e32641228d9d30d21259b9e878c6fa0',
};

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Check a ROM (or ROM-shaped) buffer against a known {size, sha256}. */
export function validateRomBuffer(buffer, expected) {
  const size = buffer.length;
  const sha256 = sha256Hex(buffer);
  return {
    size,
    sha256,
    sizeOk: size === expected.size,
    hashOk: sha256 === expected.sha256,
    ok: size === expected.size && sha256 === expected.sha256,
  };
}

// ---- RDF (romdiff patch) header ---------------------------------------
//
// Confirmed directly against the real 920413.rdf from
// https://files.mega65.org/files/other/920413_Sn7YEw.zip, and against
// romdiff's own source (MEGA65/mega65-tools, src/tools/romdiff.c): a fixed
// 256-byte header before the diff payload —
//   offset 0x00, 32 bytes: magic, "MEGA65ROMPATCH01.00", NUL-padded
//   offset 0x20, 64 bytes: reference (base) ROM filename, NUL-padded
//   offset 0x60, 160 bytes: output ROM filename, NUL-padded
// romdiff itself only checks the first 16 bytes ("MEGA65ROMPATCH01") and
// reads the reference filename as a NUL-terminated C string at offset 32 —
// this parses the same way rather than assuming this release's exact
// filenames, per the brief.
const RDF_MAGIC = 'MEGA65ROMPATCH01';
const RDF_HEADER_SIZE = 256;
const RDF_FIELDS = [
  ['magic', 0, 32],
  ['referenceFilename', 32, 64],
  ['outputFilename', 96, 160],
];

function readNulTerminated(buffer, start, maxLen) {
  const field = buffer.subarray(start, start + maxLen);
  const nul = field.indexOf(0);
  return (nul === -1 ? field : field.subarray(0, nul)).toString('ascii');
}

/**
 * Parse an .rdf patch file's header. Returns null if `buffer` is too short
 * or does not carry the expected magic — the caller should treat that as
 * "not a MEGA65 ROM diff file", the same thing romdiff itself refuses.
 */
export function parseRdfHeader(buffer) {
  if (buffer.length < RDF_HEADER_SIZE) return null;
  const magic = readNulTerminated(buffer, 0, 32);
  if (!magic.startsWith(RDF_MAGIC)) return null;
  const fields = {};
  for (const [name, start, len] of RDF_FIELDS) {
    fields[name] = readNulTerminated(buffer, start, len);
  }
  return fields;
}

// ---- canonical ROM vs. Xemu's per-user ROM -----------------------------

/**
 * How does the path Xemu reads its ROM from (~/.xemu-lgb/MEGA65.ROM) relate
 * to the canonical install (/opt/mega65/MEGA65.ROM)? Pure classifier over
 * pre-gathered facts, so it never has to be exercised against a real
 * filesystem to test the branch matrix the "never overwrite an unrelated
 * ROM without confirmation" requirement hinges on.
 *
 *   'absent'     — nothing at the link path yet; safe to create the symlink
 *   'linked'     — already a symlink to the canonical path; nothing to do
 *   'migratable' — a regular file that *is* a valid copy of the expected
 *                  ROM; safe to offer replacing it with the symlink
 *   'foreign'    — a symlink elsewhere, or a regular file that doesn't
 *                  match the expected ROM; never touch without asking
 */
export function classifyXemuRomLink({ exists, isSymlink, resolvedTarget, canonicalPath, isValidRom }) {
  if (!exists) return 'absent';
  if (isSymlink) return resolvedTarget === canonicalPath ? 'linked' : 'foreign';
  return isValidRom ? 'migratable' : 'foreign';
}

/**
 * Real-filesystem version of the above: gathers the facts `classifyXemuRomLink`
 * needs from `linkPath` and `canonicalPath`, then classifies them. Kept
 * separate from the pure classifier so doctor.mjs and setup/mega65.mjs can
 * both call this one thing instead of duplicating the fs plumbing, while
 * still being able to unit-test the decision itself without a filesystem.
 * `fs` overrides (`lstatFn`/`readlinkFn`/`readFileFn`) let both callers fake
 * the filesystem entirely for `8bs setup mega65`'s own unit tests — real
 * `node:fs/promises` functions by default.
 */
export async function inspectXemuRomLink(linkPath, canonicalPath, expected = MEGA65_ROM_920413, {
  lstatFn = fsLstat, readlinkFn = fsReadlink, readFileFn = fsReadFile,
} = {}) {
  let exists = false;
  let isSymlink = false;
  let resolvedTarget = null;
  let isValidRom = false;
  try {
    const lstat = await lstatFn(linkPath);
    exists = true;
    isSymlink = lstat.isSymbolicLink();
    if (isSymlink) {
      const target = await readlinkFn(linkPath);
      // A relative symlink target resolves against the *directory containing
      // the link*, not the link path itself.
      resolvedTarget = target.startsWith('/') ? target : resolve(dirname(linkPath), target);
    } else if (lstat.isFile()) {
      const { ok } = validateRomBuffer(await readFileFn(linkPath), { size: expected.romSize, sha256: expected.romSha256 });
      isValidRom = ok;
    }
  } catch {
    exists = false;
  }
  const state = classifyXemuRomLink({ exists, isSymlink, resolvedTarget, canonicalPath, isValidRom });
  return { state, exists, isSymlink, resolvedTarget, isValidRom };
}

/**
 * Create or repair the Xemu-local ROM link, based on what `inspectXemuRomLink`
 * found. Never touches anything but `linkPath` itself, and never overwrites
 * a 'foreign' file (an unrelated symlink, or a regular file that isn't a
 * valid copy of the expected ROM) — that always comes back as
 * 'skipped-foreign' with no write performed, regardless of `allowMigrate`.
 * A 'migratable' regular file (a valid ROM already sitting at the link path,
 * predating the canonical install) is only replaced with the symlink when
 * the caller passes `allowMigrate: true` — i.e. after asking the user.
 */
export async function ensureXemuRomLink(linkPath, canonicalPath, {
  allowMigrate = false, expected = MEGA65_ROM_920413,
  mkdir = fsMkdir, symlink = fsSymlink, unlink = fsUnlink,
  lstatFn, readlinkFn, readFileFn,
  inspect = (lp, cp, exp) => inspectXemuRomLink(lp, cp, exp, { lstatFn, readlinkFn, readFileFn }),
} = {}) {
  const inspection = await inspect(linkPath, canonicalPath, expected);
  if (inspection.state === 'linked') return { action: 'none', ...inspection };
  if (inspection.state === 'foreign') return { action: 'skipped-foreign', ...inspection };
  if (inspection.state === 'migratable' && !allowMigrate) return { action: 'skipped-migratable', ...inspection };
  await mkdir(dirname(linkPath), { recursive: true });
  if (inspection.state === 'migratable') await unlink(linkPath);
  await symlink(canonicalPath, linkPath);
  return { action: inspection.state === 'migratable' ? 'migrated' : 'linked', ...inspection };
}
