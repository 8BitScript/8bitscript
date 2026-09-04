// PATH launchers for source-built tools installed under /opt/<tool>: the
// `/usr/local/bin/<name>` entry that makes `8bs run` (and the user) able to
// type the bare command. Two kinds, chosen per tool *and per platform* by
// the target's setup module — never assumed:
//
//   symlink  /usr/local/bin/<name> -> /opt/<tool>/<name>
//   wrapper  a two-line /bin/sh script that exec's the real binary with
//            explicit arguments
//
// The wrapper exists because of a real, tested macOS failure: x16emu
// locates its default rom.bin relative to the path it was *invoked* through,
// so a direct symlink in /usr/local/bin makes it look for
// /usr/local/bin/rom.bin and die with "Cannot open /usr/local/bin/rom.bin!".
// On Linux the same symlink resolves fine. See setup/cx16.mjs for the
// per-platform choice, and inspectLauncher() below for how a launcher that
// exists but wasn't installed by this project is recognised and left alone
// until the user says otherwise.
import { lstat, readlink, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

export const MANAGED_MARKER = '# managed by 8bs setup — re-run `8bs setup <target>` rather than editing';

/** The wrapper's exact contents. The `exec` line is the tested one:
 * `exec /opt/commander-x16/x16emu -rom /opt/commander-x16/rom.bin "$@"` for
 * x16emu on macOS — `"$@"` last so every argument `8bs run` passes (-prg,
 * -run) still reaches the emulator after the explicit ROM. */
export function wrapperScript(execLine) {
  return `#!/bin/sh\n${MANAGED_MARKER}\n${execLine}\n`;
}

const defaultFs = { lstatFn: lstat, readlinkFn: readlink, readFileFn: readFile };

/**
 * What's at `path` right now, classified against what this project would
 * put there (`target` for a symlink, `execLine` for a wrapper):
 *
 *   missing          nothing there
 *   symlink          a symlink to exactly `target` — correct on Linux, the
 *                    broken layout on macOS; the caller's strategy decides
 *   wrapper          a script whose exec line is exactly `execLine`
 *   stale-wrapper    a script this project wrote (carries MANAGED_MARKER)
 *                    whose exec line is now out of date — safe to rewrite
 *   foreign-symlink  a symlink somewhere else — not ours; ask before touching
 *   foreign-file     a file (or directory) this project didn't write — same
 *
 * Pure classification: no writes, and every filesystem call is injectable.
 */
export async function inspectLauncher({ path, target, execLine }, fs = {}) {
  const { lstatFn, readlinkFn, readFileFn } = { ...defaultFs, ...fs };
  let stats;
  try {
    stats = await lstatFn(path);
  } catch {
    return { state: 'missing', path };
  }
  if (stats.isSymbolicLink()) {
    const linkTarget = await readlinkFn(path);
    return { state: linkTarget === target ? 'symlink' : 'foreign-symlink', path, target: linkTarget };
  }
  if (!stats.isFile()) return { state: 'foreign-file', path };
  let content;
  try {
    content = String(await readFileFn(path));
  } catch {
    return { state: 'foreign-file', path };
  }
  const lines = content.split('\n').map((l) => l.trim());
  if (execLine && lines.includes(execLine.trim())) return { state: 'wrapper', path, content };
  if (content.includes(MANAGED_MARKER)) return { state: 'stale-wrapper', path, content };
  return { state: 'foreign-file', path, content };
}

/**
 * Make `path` the launcher `kind` ('symlink' | 'wrapper') for `target`.
 * Idempotent: an already-correct launcher is left untouched with no sudo
 * call at all. Anything this project put there (the other kind, or a stale
 * wrapper) is replaced without asking — that's the repair path for the old
 * macOS symlink layout. Anything foreign is only replaced when
 * `confirmReplace(inspection)` says so; otherwise it's reported and left.
 *
 * Both writes go through `sudoExec` (and so exec.mjs's allowlist): `ln -sf`
 * for a symlink, and `install -m755` of a wrapper staged in `workDir` as
 * the normal user. Both replace a symlink or regular file already at the
 * path — BSD and GNU `install` unlink the destination first, and `ln -f`
 * does by definition — so no separate `rm` runs as root.
 */
export async function ensureLauncher({
  path, kind, target, execLine, sudoExec, workDir, confirmReplace = async () => false,
}, fs = {}) {
  const { mkdirFn = mkdir, writeFileFn = writeFile } = fs;
  const inspection = await inspectLauncher({ path, target, execLine }, fs);
  const correct = kind === 'symlink' ? 'symlink' : 'wrapper';
  if (inspection.state === correct) return { ok: true, action: 'unchanged', inspection };

  const foreign = inspection.state === 'foreign-symlink' || inspection.state === 'foreign-file';
  if (foreign && !(await confirmReplace(inspection))) {
    return { ok: false, action: 'skipped-foreign', inspection };
  }
  const action = inspection.state === 'missing' ? 'created' : foreign ? 'replaced' : 'repaired';

  if (kind === 'symlink') {
    const r = await sudoExec('ln', ['-sf', target, path]);
    if (r.code !== 0) return { ok: false, action: 'failed', step: 'ln', code: r.code, inspection };
    return { ok: true, action, inspection };
  }
  await mkdirFn(workDir, { recursive: true });
  const staged = join(workDir, `${basename(path)}.launcher`);
  await writeFileFn(staged, wrapperScript(execLine), { mode: 0o755 });
  const r = await sudoExec('install', ['-m755', staged, path]);
  if (r.code !== 0) return { ok: false, action: 'failed', step: 'install', code: r.code, inspection };
  return { ok: true, action, inspection };
}
