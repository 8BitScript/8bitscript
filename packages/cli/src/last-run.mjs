// The last-run report: a small JSON file in dist/ that `8bs run`/`8bs build`
// write once the compile has an answer, and that the editor's Running
// machines tree reads. The terminal still prints the same memory line and
// `--size` breakdown a person would see; this file is that answer as data,
// so a side bar does not have to scrape a task's stdout.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

export const LAST_RUN_PREFIX = '.8bs-last-';

/** Absolute path of the last-run file for `target`, under `cwd/dist`. */
export function lastRunPath(target, cwd = process.cwd()) {
  return join(resolve(cwd, 'dist'), `${LAST_RUN_PREFIX}${target}.json`);
}

/**
 * The hardware a last-run file carries: what a program was built for, not
 * the emulator flag lists that launched it. Those stay on the invocation.
 *
 * @param {object|null|undefined} hardware
 * @returns {{ machine: string, label: string, profile: string|null, options: object, facts: object }|null}
 */
export function hardwareSnapshot(hardware) {
  if (!hardware || typeof hardware !== 'object') return null;
  return {
    machine: hardware.machine,
    label: hardware.label ?? 'stock',
    profile: hardware.profile ?? null,
    options: hardware.options ?? {},
    facts: hardware.facts ?? {},
  };
}

/** `outFile` relative to `cwd` when it lives inside it, else unchanged. */
export function displayOutFile(outFile, cwd = process.cwd()) {
  if (!outFile) return null;
  const rel = relative(cwd, outFile);
  return rel && !rel.startsWith('..') && !rel.startsWith('/') ? rel : outFile;
}

/**
 * Merge `patch` into the last-run file for `data.target` (or `patch.target`).
 * Compile writes the first copy (memory, size, hardware); run/boot fill in
 * the emulator and, for web, the serving URL once the server is listening.
 *
 * @param {string} target
 * @param {object} patch
 */
export async function writeLastRun(target, patch, cwd = process.cwd()) {
  const dest = lastRunPath(target, cwd);
  let current = {};
  try {
    current = JSON.parse(await readFile(dest, 'utf8'));
  } catch {
    // First write for this target, or a previous file we cannot read.
  }
  const next = {
    ...current,
    ...patch,
    target,
    writtenAt: new Date().toISOString(),
  };
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, dest);
  return next;
}

/**
 * What compile() hands writeLastRun: memory, the `--size` entries when
 * asked for, the hardware snapshot, and the built file.
 */
export function compileReport(target, { outFile, hardware, memory, sizeReport, frameRate }, cwd = process.cwd()) {
  return {
    target,
    outFile: displayOutFile(outFile, cwd),
    frameRate: frameRate ?? null,
    memory: memory ?? null,
    size: Array.isArray(sizeReport) ? sizeReport : [],
    hardware: hardwareSnapshot(hardware),
  };
}
