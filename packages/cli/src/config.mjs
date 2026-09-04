// Shared 8bs.config.ts loading, used by both `8bs build` and `8bs check` (and,
// through them, anything else that needs a project's config without
// duplicating the loader).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The project's 8bs.config.ts, if present. Node 26 imports TypeScript with
 * type stripping, so the config is an ordinary module, not a parsed format.
 *
 * @param {string} dir
 * @param {string} [label] Prefixes a load error, e.g. "8bs build".
 */
export async function loadConfig(dir, label = '8bs') {
  const path = join(dir, '8bs.config.ts');
  if (!existsSync(path)) return null;
  try {
    const module = await import(pathToFileURL(path).href);
    return module.default ?? null;
  } catch (error) {
    process.stderr.write(`${label}: cannot load 8bs.config.ts: ${error.message}\n`);
    return null;
  }
}

/**
 * The project's logical `frame()` rate — the same rate on every target,
 * independent of --pal (which only selects a real hardware/emulator
 * region, not the logical rate; see packages/backend-6502's FRAME_SYNC).
 * Defaults to 60; `seconds(...)` durations and the frame()-driver loop are
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
      error: `8bs.config.ts's frameRate must be a positive integer, got ${JSON.stringify(config?.frameRate)}`,
    };
  }
  return { ok: true, frameRate };
}
