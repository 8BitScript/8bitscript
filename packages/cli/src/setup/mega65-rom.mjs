// Building MEGA65.ROM from a user-supplied, legally obtained C65 base ROM
// plus the official 920413 patch — the pipeline docs/setup/mega65.md
// documents in prose. Every step here is a thin, mockable wrapper around one
// piece of I/O (a download, an extraction, a build, a filesystem write), so
// setup/mega65.mjs can drive them under real conditions while tests drive
// them under fakes. Nothing in this file ever bundles, mirrors, or commits
// ROM bytes — it only ever operates on files the user already has, or the
// freely-redistributable .rdf patch (a diff, not ROM content) from MEGA65's
// own file host.
import {
  mkdir, readFile, cp, rm, access,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { execInherit, execCapture } from './exec.mjs';
import { readZipEntries, extractZipEntry, findZipEntry } from './zip.mjs';
import {
  C65_BASE_ROM, MEGA65_ROM_920413, validateRomBuffer, parseRdfHeader,
} from './rom.mjs';
import { mega65ToolsSourceDir } from './paths.mjs';

/** Recursively find a file by exact basename under `rootDir`. Node's own
 * recursive readdir, rather than shelling out to `find` — no risk of an
 * untrusted path (an MSI's own internal names) reaching a shell. */
export async function findByBasename(rootDir, basename, readdirFn) {
  const { readdir } = await import('node:fs/promises');
  const list = readdirFn ?? readdir;
  const entries = await list(rootDir, { recursive: true, withFileTypes: true });
  const match = entries.find((e) => e.isFile() && e.name === basename);
  if (!match) return null;
  const parent = match.parentPath ?? match.path;
  return join(parent, match.name);
}

/** `msiextract -C <destDir> <msiPath>` — always as the normal user; never
 * under sudo (the brief is explicit: msiextract never runs elevated). */
export function extractC64ForeverMsi(msiPath, destDir, exec = execInherit) {
  return exec('msiextract', ['-C', destDir, msiPath]);
}

/** Locate and validate the C65 910828 base ROM inside an extracted C64
 * Forever tree. Returns `{ path, buffer, validation }` or null if the file
 * isn't found anywhere under `extractedDir`. Validation failure is not
 * thrown — the caller decides how to report a wrong/corrupt base ROM, per
 * the brief's "stop and explain" requirement. */
export async function locateC65BaseRom(extractedDir, { find = findByBasename, read = readFile } = {}) {
  const path = await find(extractedDir, C65_BASE_ROM.filename);
  if (!path) return null;
  const buffer = await read(path);
  return { path, buffer, validation: validateRomBuffer(buffer, C65_BASE_ROM) };
}

/**
 * Get the 920413 .rdf patch's bytes, either from a local zip the user
 * already downloaded (`localZipPath` — the escape hatch for the case the
 * user flagged: `patchUrl`'s hashed-looking suffix may not be stable) or by
 * downloading `MEGA65_ROM_920413.patchUrl` fresh. Either way the zip is read
 * with the pure zip.mjs reader, never shelled out to `unzip`.
 */
export async function fetchRomPatch(
  { localZipPath, fetchImpl = fetch, read = readFile } = {},
) {
  const zipBytes = localZipPath
    ? Buffer.from(await read(localZipPath))
    : await downloadZip(fetchImpl, MEGA65_ROM_920413.patchUrl);

  const entries = readZipEntries(zipBytes);
  const rdfEntry = findZipEntry(entries, MEGA65_ROM_920413.rdfEntryName);
  if (!rdfEntry) {
    throw new Error(
      `the ROM patch archive did not contain ${MEGA65_ROM_920413.rdfEntryName} — `
      + 'it may be a different release than expected',
    );
  }
  const rdfBytes = extractZipEntry(zipBytes, rdfEntry);
  const header = parseRdfHeader(rdfBytes);
  if (!header) {
    throw new Error(`${MEGA65_ROM_920413.rdfEntryName} does not look like a MEGA65 ROM diff file`);
  }
  return { rdfBytes, header };
}

async function downloadZip(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch (cause) {
    throw new Error(
      `could not download the MEGA65 ROM patch from ${url} — `
      + `the download URL may have changed since this was written; pass --rom-patch <zip> `
      + `with a copy downloaded by hand from https://files.mega65.org/`,
      { cause },
    );
  }
  if (!response.ok) {
    throw new Error(
      `downloading the MEGA65 ROM patch from ${url} failed (HTTP ${response.status}) — `
      + `the download URL may have changed since this was written; pass --rom-patch <zip> `
      + `with a copy downloaded by hand from https://files.mega65.org/`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Clone-or-update MEGA65/mega65-tools into the setup source cache, and
 * build only `bin/romdiff` — never `make all`, which the brief confirms
 * fails under GCC 16 in the bundled cbmconvert project (a `false` enum
 * identifier colliding with the C23 `false` keyword) and which this project
 * doesn't need anyway. `which: no acme` warnings from this build are
 * upstream noise and are not treated as failure — only a non-zero `make`
 * exit or a missing resulting binary is. */
export async function buildRomdiff({
  sourceDir = mega65ToolsSourceDir(),
  repo = 'https://github.com/MEGA65/mega65-tools.git',
  exec = execInherit,
  exists = async (p) => { try { await access(p); return true; } catch { return false; } },
  mkdirFn = mkdir,
} = {}) {
  const gitDir = join(sourceDir, '.git');
  if (await exists(gitDir)) {
    const pull = await exec('git', ['-C', sourceDir, 'pull', '--ff-only']);
    if (pull.code !== 0) return { ok: false, step: 'git pull', code: pull.code };
  } else {
    await mkdirFn(dirname(sourceDir), { recursive: true });
    const clone = await exec('git', ['clone', repo, sourceDir]);
    if (clone.code !== 0) return { ok: false, step: 'git clone', code: clone.code };
  }
  const build = await exec('make', ['bin/romdiff'], { cwd: sourceDir });
  const binaryPath = join(sourceDir, 'bin', 'romdiff');
  if (build.code !== 0 || !(await exists(binaryPath))) {
    return { ok: false, step: 'make bin/romdiff', code: build.code, binaryPath };
  }
  return { ok: true, binaryPath };
}

/**
 * Run `romdiff <rdfPath> <outputPath>` in a scratch working directory that
 * contains only the base ROM, copied in under the exact filename the .rdf's
 * own header names (`header.referenceFilename`, e.g. `910828.BIN`) — romdiff
 * reads that filename from the diff file itself and looks for it in its
 * current directory, so this never assumes a hardcoded name. The user's
 * original base-ROM file and the mega65-tools checkout are both left
 * untouched; everything romdiff touches lives under `workDir`.
 */
export async function patchRom({
  romdiffPath, rdfPath, workDir, baseRomPath, header, exec = execCapture, copy = cp, mkdirFn = mkdir, read = readFile,
}) {
  await mkdirFn(workDir, { recursive: true });
  const referenceFilename = header.referenceFilename;
  await copy(baseRomPath, join(workDir, referenceFilename));
  const outputPath = join(workDir, 'MEGA65.ROM');
  const result = await exec(romdiffPath, [rdfPath, outputPath], { cwd: workDir });
  if (result.code !== 0) {
    return { ok: false, output: result.stdout + result.stderr };
  }
  const buffer = await read(outputPath);
  const validation = validateRomBuffer(buffer, { size: MEGA65_ROM_920413.romSize, sha256: MEGA65_ROM_920413.romSha256 });
  return {
    ok: validation.ok, outputPath, buffer, validation, output: result.stdout + result.stderr,
  };
}

export async function cleanupWorkDir(workDir, remove = rm) {
  await remove(workDir, { recursive: true, force: true });
}
