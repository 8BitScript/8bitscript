// `8bs check` — run the compiler's diagnostics over files and print them.
//
// The output format is the one the editor shows, in terminal form. Both come
// from the same analyze() call, so a green `8bs check` and a clean editor mean
// the same thing.
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { analyze, positionAt } from '@8bitscript/compiler';

import { loadConfig, resolveFrameRate } from './config.mjs';

/**
 * @param {string[]} files
 * @returns {Promise<number>} process exit code
 */
export async function check(files) {
  if (files.length === 0) {
    process.stderr.write('8bs check: no files given\n\nUsage: 8bs check <file.8bs> [...]\n');
    return 2;
  }

  // The same project-level `frameRate` a build would use (8bs.config.ts,
  // default 60) — `frames(...)` folds against it, so a project's `8bs
  // check` and its `8bs build` agree on what a duration means. There is no
  // per-project config for the language server yet (no workspace-root
  // concept to load 8bs.config.ts from), so its diagnostics still assume 60
  // until that's picked up as follow-up work.
  const config = await loadConfig(process.cwd(), '8bs check');
  const frameRateResult = resolveFrameRate(config);
  if (!frameRateResult.ok) {
    process.stderr.write(`8bs check: ${frameRateResult.error}\n`);
    return 2;
  }
  const { frameRate } = frameRateResult;

  let total = 0;

  for (const file of files) {
    const path = resolve(file);
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      process.stderr.write(`8bs check: cannot read ${file}\n`);
      total += 1;
      continue;
    }

    const display = relative(process.cwd(), path) || file;
    // Resolution needs the real path; the display path is only for printing.
    for (const d of analyze(text, path, { resolveImports: true, frameRate })) {
      const { line, column } = positionAt(text, d.start);
      process.stdout.write(`${display}:${line}:${column}\n`);
      process.stdout.write(`${d.severity} ${d.code}: ${d.message}\n\n`);
      total += 1;
    }
  }

  if (total === 0) {
    process.stdout.write(`Checked ${files.length} file(s). No problems found.\n`);
    return 0;
  }

  process.stdout.write(`${total} problem(s) found.\n`);
  return 1;
}
