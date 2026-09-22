// The WebAssembly x16emu behind `8bs run cx16 --web`: X16Community ships
// one with every emulator release (`x16emu_wasm-<tag>.zip`, built with
// `make wasm` from the same source as the native binary, ROM embedded in
// x16emu.data). Pinned to one release by tag and SHA-256 and unpacked into
// the user's cache on first use — no Emscripten, no sudo, no PATH.
//
// Pinned rather than "latest" on purpose: the page web-emulator.mjs writes
// drives x16emu.js through Emscripten's Module contract (`arguments`,
// `preRun`, `canvas`), and the KERNAL facts packages/cx16 relies on were
// read against a specific ROM. r49 is the release confirmed to boot
// Studio's main-cx16.prg (menubar, "INPUT KEYS MOUSE", pointer) under
// headless Chromium; bump the three fields together after checking again.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { pathExists } from './source.mjs';
import { extractZipEntry, findZipEntry, readZipEntries } from './zip.mjs';
import { x16emuWasmDir } from './paths.mjs';

export const X16EMU_WASM_RELEASE = Object.freeze({
  tag: 'r49',
  url: 'https://github.com/X16Community/x16-emulator/releases/download/r49/x16emu_wasm-r49.zip',
  sha256: '9711036cf5b33504815b278fa872b8ec20aef9cb609fd7b17f3685d91312628f',
  // The three files the emulator page loads; the archive's own page,
  // stylesheet, loader (webassembly/main.js) and JSZip are not served —
  // web-emulator.mjs has its own shell so the argv is the native one.
  files: Object.freeze(['x16emu.js', 'x16emu.wasm', 'x16emu.data']),
});

/**
 * Where the pinned release lives (or would live) on this machine, and
 * which of its files are missing. Read-only; `8bs doctor`-shaped.
 *
 * @param {{ release?: typeof X16EMU_WASM_RELEASE, dir?: string, exists?: (p: string) => Promise<boolean> }} [io]
 * @returns {Promise<{ dir: string, present: boolean, missing: string[] }>}
 */
export async function inspectX16emuWasm({ release = X16EMU_WASM_RELEASE, dir = x16emuWasmDir(release.tag), exists = pathExists } = {}) {
  const missing = [];
  for (const name of release.files) {
    if (!(await exists(join(dir, name)))) missing.push(name);
  }
  return { dir, present: missing.length === 0, missing };
}

/** Lower-case hex SHA-256 of `bytes`. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Make sure the pinned release is unpacked, downloading it when it is
 * not. A directory that already holds every file is left alone without a
 * request; anything short of that (first use, an interrupted unpack) is
 * fetched again in full, checked against the pinned SHA-256 before a byte
 * is written, and unpacked file by file. Never runs anything.
 *
 * @param {{
 *   release?: typeof X16EMU_WASM_RELEASE, dir?: string,
 *   fetchImpl?: typeof fetch, exists?: (p: string) => Promise<boolean>,
 *   mkdirFn?: typeof mkdir, writeFileFn?: typeof writeFile,
 *   report?: (line: string) => void,
 * }} [io]
 * @returns {Promise<{ ok: true, dir: string, downloaded: boolean } | { ok: false, error: string }>}
 */
export async function ensureX16emuWasm({
  release = X16EMU_WASM_RELEASE, dir = x16emuWasmDir(release.tag), fetchImpl = fetch,
  exists = pathExists, mkdirFn = mkdir, writeFileFn = writeFile, report = () => {},
} = {}) {
  const state = await inspectX16emuWasm({ release, dir, exists });
  if (state.present) return { ok: true, dir, downloaded: false };

  report(`downloading x16emu ${release.tag} (WebAssembly) from ${release.url}`);
  let response;
  try {
    response = await fetchImpl(release.url);
  } catch (err) {
    return { ok: false, error: `could not download ${release.url} (${err?.message ?? err}) — check the connection and try again` };
  }
  if (!response.ok) {
    return { ok: false, error: `downloading ${release.url} failed (HTTP ${response.status}) — the release asset may have moved; the pin lives in packages/cli/src/setup/cx16-web.mjs` };
  }
  const zip = Buffer.from(await response.arrayBuffer());
  const digest = sha256Hex(zip);
  if (digest !== release.sha256) {
    return { ok: false, error: `${release.url} does not match the pinned SHA-256 (got ${digest}); nothing was written — the pin lives in packages/cli/src/setup/cx16-web.mjs` };
  }

  let entries;
  try {
    entries = readZipEntries(zip);
  } catch (err) {
    return { ok: false, error: `${release.url} is not a zip this reader understands (${err.message})` };
  }
  const found = release.files.map((name) => [name, findZipEntry(entries, name)]);
  const absent = found.filter(([, entry]) => !entry).map(([name]) => name);
  if (absent.length > 0) {
    return { ok: false, error: `${release.url} has no ${absent.join(', ')} — the archive layout changed; the pin lives in packages/cli/src/setup/cx16-web.mjs` };
  }
  for (const [name, entry] of found) {
    const dest = join(dir, name);
    await mkdirFn(dirname(dest), { recursive: true });
    await writeFileFn(dest, extractZipEntry(zip, entry));
  }
  report(`unpacked x16emu ${release.tag} into ${dir}`);
  return { ok: true, dir, downloaded: true };
}
