// Canonical filesystem locations `8bs setup` reads and writes. Centralised
// so doctor.mjs's readiness checks and setup/mega65.mjs's install steps
// agree on where things live without duplicating the paths by hand.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where source checkouts/build trees for setup-built tools are cached,
 * rather than assuming ~/Development or dropping them in cwd. XDG_CACHE_HOME
 * is honoured for anyone who has set it; ~/.cache is the common default on
 * Arch/Manjaro either way. */
export function setupCacheDir() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, '8bitscript', 'setup');
}

export function xemuSourceDir() {
  return join(setupCacheDir(), 'xemu');
}

export function mega65ToolsSourceDir() {
  return join(setupCacheDir(), 'mega65-tools');
}

/** Scratch space for MSI extraction and ROM-patch downloads — contents are
 * disposable and never installed from directly; see setup/mega65.mjs. */
export function mega65WorkDir() {
  return join(setupCacheDir(), 'mega65-rom-work');
}

export const XEMU_INSTALL_DIR = '/opt/xemu';
export const XMEGA65_INSTALL_PATH = '/opt/xemu/xmega65';
export const XMEGA65_SYMLINK_PATH = '/usr/local/bin/xmega65';

export const MEGA65_ROM_INSTALL_DIR = '/opt/mega65';
export const MEGA65_ROM_CANONICAL_PATH = '/opt/mega65/MEGA65.ROM';

/** Xemu's own per-user data directory on Linux — it may not exist yet if
 * Xemu has never been run; setup creates it if needed rather than requiring
 * a prior launch. */
export function xemuUserDataDir() {
  return join(homedir(), '.xemu-lgb');
}

export function xemuRomLinkPath() {
  return join(xemuUserDataDir(), 'MEGA65.ROM');
}
