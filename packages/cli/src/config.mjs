// Shared 8bitscript.config.ts loading, used by both `8bs build` and `8bs
// check` (and, through them, anything else that needs a project's config
// without duplicating the loader).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 8bitscript.config.ts is the current name; 8bs.config.ts (every project
// through 0.3.0, including this repo's own examples) still loads so
// existing projects don't break on upgrade. Checked in this order — a
// project with both gets the new name silently, not a conflict, since
// there's nothing to reconcile: whichever loads first wins.
const CONFIG_FILENAMES = ['8bitscript.config.ts', '8bs.config.ts'];

/**
 * The project's 8bitscript.config.ts (or the older 8bs.config.ts), if
 * present. Node 26 imports TypeScript with type stripping, so the config is
 * an ordinary module, not a parsed format.
 *
 * @param {string} dir
 * @param {string} [label] Prefixes a load error, e.g. "8bs build".
 */
export async function loadConfig(dir, label = '8bs') {
  for (const filename of CONFIG_FILENAMES) {
    const path = join(dir, filename);
    if (!existsSync(path)) continue;
    try {
      const module = await import(pathToFileURL(path).href);
      return module.default ?? null;
    } catch (error) {
      process.stderr.write(`${label}: cannot load ${filename}: ${error.message}\n`);
      return null;
    }
  }
  return null;
}

/**
 * Whether a program hands the machine back in the state it was given.
 *
 * Today that is one thing: the character set it was launched in. A program
 * that prints selects the text set itself, so without this a run on a PET
 * that booted in graphics/upper-case (the 3032 and 4032 both do) leaves its
 * owner at a lower-case BASIC prompt they never asked for. The program
 * exits in whichever mode it entered — not a fixed mode, so a machine
 * launched in lower case (the 8032) is given back in lower case too.
 *
 * Defaults to true. `restoreOnExit: false` buys the bytes back (on the PET:
 * four in the prologue, four in the epilogue, and no RAM at all — the saved
 * byte rides the CPU stack) for a program that would rather keep them, or
 * one that deliberately means to leave the machine as it left it.
 *
 * @param {object|null} config
 * @returns {{ ok: true, restoreOnExit: boolean } | { ok: false, error: string }}
 */
export function resolveRestoreOnExit(config) {
  const restoreOnExit = config?.restoreOnExit ?? true;
  if (typeof restoreOnExit !== 'boolean') {
    return {
      ok: false,
      error: `8bitscript.config.ts's restoreOnExit must be true or false, got ${JSON.stringify(config?.restoreOnExit)}`,
    };
  }
  return { ok: true, restoreOnExit };
}

/**
 * The project's logical frame rate — what `waitFrame()` runs at, the same on every target,
 * independent of --pal (which only selects a real hardware/emulator
 * region, not the logical rate; see packages/compiler/src/mos FRAME_SYNC).
 * Defaults to 60; `#frames(...)` durations and the waitFrame() runtime are
 * both built against whatever this resolves to.
 *
 * @param {object|null} config
 * @returns {{ ok: true, frameRate: number } | { ok: false, error: string }}
 */
export function resolveFrameRate(config) {
  const frameRate = config?.frameRate ?? 60;
  if (!Number.isInteger(frameRate) || frameRate <= 0) {
    return {
      ok: false,
      error: `8bitscript.config.ts's frameRate must be a positive integer, got ${JSON.stringify(config?.frameRate)}`,
    };
  }
  return { ok: true, frameRate };
}
