// Building and installing xmega65 (Xemu's MEGA65 core) from source. The AUR
// `xmega65-git` package is deliberately not used anywhere in this
// project — see doctor.mjs's INSTALLERS.xmega65 comment — so this is the
// only path `8bs setup mega65` has to a working emulator.
import { lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { execInherit } from './exec.mjs';
import { syncRepository, runBuild, pathExists } from './source.mjs';
import {
  xemuSourceDir, XEMU_INSTALL_DIR, XMEGA65_INSTALL_PATH, XMEGA65_SYMLINK_PATH,
  xemuUserDataDir, xemuMega65RealDataDir,
} from './paths.mjs';

const XEMU_REPO = 'https://github.com/lgblgblgb/xemu.git';

/**
 * Clone-or-update lgblgblgb/xemu, then `make` only `targets/mega65` — this
 * project has no use for Xemu's other machine cores. Harmless compiler
 * warnings (confirmed against GCC 16 / sdl2-compat 2.32.70 / GTK3 on current
 * Arch, and against Apple clang 21 / SDL 2.32.72 on Apple Silicon macOS —
 * "experimental memory data pointers", "no _mm_malloc() on ARM", unused
 * variables) are not a failure; only a non-zero `make` exit or a missing
 * resulting binary is.
 */
export async function buildXemuMega65({
  sourceDir = xemuSourceDir(), repo = XEMU_REPO, exec = execInherit, exists = pathExists, mkdirFn = mkdir,
} = {}) {
  const sync = await syncRepository({ sourceDir, repo, exec, exists, mkdirFn });
  if (!sync.ok) return sync;
  const binaryPath = join(sourceDir, 'build', 'bin', 'xmega65.native');
  const build = await runBuild({ cwd: join(sourceDir, 'targets', 'mega65'), artifacts: [binaryPath], exec, exists });
  if (!build.ok) return { ...build, binaryPath };
  return { ok: true, binaryPath };
}

/**
 * Install the built binary system-wide: `/opt/xemu/xmega65` (never named
 * `xmega65.native` — the brief is explicit). Putting it on `PATH` is a
 * separate step — see xmega65LauncherSpec() and setup/launcher.mjs — so a
 * foreign `/usr/local/bin/xmega65` is never silently overwritten here.
 */
export async function installXemu(binaryPath, { sudoExec, installDir = XEMU_INSTALL_DIR, installPath = XMEGA65_INSTALL_PATH } = {}) {
  const mkdirResult = await sudoExec('mkdir', ['-p', installDir]);
  if (mkdirResult.code !== 0) return { ok: false, step: 'mkdir', code: mkdirResult.code };
  const installResult = await sudoExec('install', ['-m755', binaryPath, installPath]);
  if (installResult.code !== 0) return { ok: false, step: 'install', code: installResult.code };
  return { ok: true, installPath };
}

/**
 * Unlike Commander X16's x16emu, a plain `/usr/local/bin/xmega65 ->
 * /opt/xemu/xmega65` symlink works correctly on macOS too — confirmed on a
 * real Apple Silicon install: Xemu resolves its own data directory from
 * `$HOME`, never from the path it was invoked through, so there's no
 * platform split here and no wrapper script.
 */
export function xmega65LauncherSpec() {
  return { path: XMEGA65_SYMLINK_PATH, target: XMEGA65_INSTALL_PATH, execLine: null, kind: 'symlink' };
}

/**
 * What's at Xemu's `~/.xemu-lgb` compatibility path right now: `'missing'`
 * (nothing there yet), `'symlink'` (resolved to its real target — Xemu's
 * own first-run behaviour, or a prior run of this function), or `'other'`
 * (a real directory, or anything else Xemu itself put there — left alone
 * either way).
 */
export async function inspectXemuDataDir(linkPath, { lstatFn = lstat, readlinkFn = readlink } = {}) {
  let stats;
  try {
    stats = await lstatFn(linkPath);
  } catch {
    return { state: 'missing' };
  }
  if (stats.isSymbolicLink()) {
    const target = await readlinkFn(linkPath);
    const resolved = target.startsWith('/') ? target : resolve(dirname(linkPath), target);
    return { state: 'symlink', target: resolved };
  }
  return { state: 'other' };
}

/**
 * Xemu creates `~/.xemu-lgb` itself, as a compatibility symlink into its
 * real per-platform data directory (`~/Library/Application Support/
 * xemu-lgb/mega65` on macOS, `~/.local/share/xemu-lgb/mega65` on Linux —
 * both confirmed on real first launches), the first time it runs. Setup
 * never launches the emulator just to get that layout, so if nothing is
 * there yet it creates the identical layout itself: the real directory,
 * then the symlink — so the ROM link step right after this has somewhere
 * correct to land. Anything already at `linkPath` — any symlink, or a real
 * directory — is Xemu's own (or a prior run of this same function) and is
 * left completely untouched, per the brief's "never overwrite an existing
 * ~/.xemu-lgb that points somewhere else" — extended here to "never
 * overwrite it at all" once it exists.
 */
export async function ensureXemuDataDir({
  platform = process.platform, linkPath = xemuUserDataDir(), realDir = xemuMega65RealDataDir(platform),
  mkdirFn = mkdir, symlinkFn = symlink, inspect = inspectXemuDataDir,
} = {}) {
  const inspection = await inspect(linkPath);
  if (inspection.state !== 'missing') return { ok: true, action: 'unchanged', ...inspection };
  await mkdirFn(realDir, { recursive: true });
  await symlinkFn(realDir, linkPath);
  return { ok: true, action: 'created', realDir };
}
