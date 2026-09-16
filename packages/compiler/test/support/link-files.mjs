// Link a set of source files from a scratch directory — the shape most
// multi-module compiler tests need, kept in one place.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { link } from '../../index.mjs';

/**
 * Write `files` (name → text) into a fresh directory, link `entry` from
 * there with `options`, and remove the directory again. The linked result
 * is returned with `dir` added, for a test that wants to name the path.
 *
 * @param {Record<string, string>} files
 * @param {string} entry a key of `files`
 * @param {object} [options] link() options; `machine: 'pet'` and a 60 Hz frame rate by default
 */
export function linkFiles(files, entry, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), '8bs-link-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return { ...link(files[entry], join(dir, entry), { machine: 'pet', frameRate: 60, facts: {}, ...options }), dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
