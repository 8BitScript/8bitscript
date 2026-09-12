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
 * Options a project may still carry in its 8bitscript.config.ts that no
 * longer do anything. A build names them rather than ignoring them: a knob
 * that silently stopped working is worse than one that says so, and the
 * project can delete the line knowing what it bought.
 *
 * `restoreOnExit` saved the PET's character-set register on the way in and
 * put it back on the way out, so a machine that booted in graphics/upper
 * case returned to an upper-case `READY.`. The bit is retroactive — it
 * selects the ROM the video hardware reads for every cell already on
 * screen — so restoring it re-rendered the text the program had just
 * drawn, through the set it had switched away from to draw it. It undid
 * the reason it existed. See packages/pet/AGENTS.md.
 */
export const RETIRED_OPTIONS = new Map([
  ['restoreOnExit', 'a program now exits in whatever character set it selected; putting the old one back re-rendered the text it had just drawn'],
]);

/**
 * One message per retired option `config` still sets — empty for the
 * projects that never did, which is all of them but the ones written
 * against 0.5.0.
 *
 * @param {object|null} config
 * @returns {string[]}
 */
export function retiredOptionWarnings(config) {
  if (!config || typeof config !== 'object') return [];
  return [...RETIRED_OPTIONS]
    .filter(([name]) => name in config)
    .map(([name, why]) => `8bitscript.config.ts's ${name} no longer does anything: ${why}`);
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
