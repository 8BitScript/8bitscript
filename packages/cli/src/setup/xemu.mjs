// Building and installing xmega65 (Xemu's MEGA65 core) from source. The AUR
// `xmega65-git` package is deliberately not used anywhere in this
// project — see doctor.mjs's INSTALLERS.xmega65 comment — so this is the
// only path `8bs setup mega65` has to a working emulator.
import { access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { execInherit } from './exec.mjs';
import { xemuSourceDir, XEMU_INSTALL_DIR, XMEGA65_INSTALL_PATH, XMEGA65_SYMLINK_PATH } from './paths.mjs';

const XEMU_REPO = 'https://github.com/lgblgblgb/xemu.git';

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone-or-update lgblgblgb/xemu, then `make` only `targets/mega65` — this
 * project has no use for Xemu's other machine cores. Harmless compiler
 * warnings (confirmed against GCC 16 / sdl2-compat 2.32.70 / GTK3 on current
 * Arch) are not a failure; only a non-zero `make` exit or a missing
 * resulting binary is.
 */
export async function buildXemuMega65({
  sourceDir = xemuSourceDir(), repo = XEMU_REPO, exec = execInherit, exists = pathExists, mkdirFn = mkdir,
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
  const build = await exec('make', [], { cwd: join(sourceDir, 'targets', 'mega65') });
  const binaryPath = join(sourceDir, 'build', 'bin', 'xmega65.native');
  if (build.code !== 0 || !(await exists(binaryPath))) {
    return { ok: false, step: 'make', code: build.code, binaryPath };
  }
  return { ok: true, binaryPath };
}

/**
 * Install the built binary system-wide: `/opt/xemu/xmega65` (never named
 * `xmega65.native` — the brief is explicit) plus a `/usr/local/bin/xmega65`
 * symlink. The only three sudo operations this step needs — see
 * exec.mjs's SUDO_ALLOWED_ROOTS.
 */
export async function installXemu(binaryPath, { sudoExec, installDir = XEMU_INSTALL_DIR, installPath = XMEGA65_INSTALL_PATH, symlinkPath = XMEGA65_SYMLINK_PATH } = {}) {
  const mkdirResult = await sudoExec('mkdir', ['-p', installDir]);
  if (mkdirResult.code !== 0) return { ok: false, step: 'mkdir', code: mkdirResult.code };
  const installResult = await sudoExec('install', ['-m755', binaryPath, installPath]);
  if (installResult.code !== 0) return { ok: false, step: 'install', code: installResult.code };
  const linkResult = await sudoExec('ln', ['-sf', installPath, symlinkPath]);
  if (linkResult.code !== 0) return { ok: false, step: 'ln', code: linkResult.code };
  return { ok: true, installPath, symlinkPath };
}
