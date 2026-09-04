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

/** Xemu's own compatibility symlink, on every platform: `~/.xemu-lgb`,
 * pointing at the real per-platform data directory below. It may not exist
 * yet if Xemu has never been run; setup creates the same layout itself if
 * needed rather than requiring a prior launch — see setup/xemu.mjs's
 * ensureXemuDataDir(). */
export function xemuUserDataDir() {
  return join(homedir(), '.xemu-lgb');
}

export function xemuRomLinkPath() {
  return join(xemuUserDataDir(), 'MEGA65.ROM');
}

/** Xemu's real, platform-specific MEGA65 data directory — what
 * `~/.xemu-lgb` is a compatibility symlink *to*. Confirmed against a real
 * first launch on both platforms: macOS uses the standard Application
 * Support location, Linux uses XDG's `~/.local/share`. */
export function xemuMega65RealDataDir(platform = process.platform) {
  return platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'xemu-lgb', 'mega65')
    : join(homedir(), '.local', 'share', 'xemu-lgb', 'mega65');
}

// ---- Commander X16 ---------------------------------------------------------
//
// The emulator (x16-emulator) and its ROM (x16-rom) are two upstream
// repositories that have to be built from the same point in time — upstream
// is explicit that an emulator expects a matching ROM — so they get two
// sibling source checkouts under the same cache and one shared install dir.

export function x16EmulatorSourceDir() {
  return join(setupCacheDir(), 'x16-emulator');
}

export function x16RomSourceDir() {
  return join(setupCacheDir(), 'x16-rom');
}

/** Scratch space for the wrapper script setup stages before `sudo install`
 * copies it into /usr/local/bin — written as the normal user, never as root. */
export function cx16WorkDir() {
  return join(setupCacheDir(), 'cx16-work');
}

export const CX16_INSTALL_DIR = '/opt/commander-x16';
export const X16EMU_INSTALL_PATH = '/opt/commander-x16/x16emu';
export const MAKECART_INSTALL_PATH = '/opt/commander-x16/makecart';
export const CX16_ROM_INSTALL_PATH = '/opt/commander-x16/rom.bin';

export const LOCAL_BIN_DIR = '/usr/local/bin';
export const X16EMU_LAUNCHER_PATH = '/usr/local/bin/x16emu';
export const MAKECART_LAUNCHER_PATH = '/usr/local/bin/makecart';
