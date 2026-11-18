// The front-end dump of the oracle corpus: for every source file (.8bs .8bx
// .8bg .8ba), the lexer's tokens, the parser's syntax tree and the front end's
// diagnostics, written under `<out>/fe/<tokpath>/` as `tokens.json`,
// `ast.json` and `diagnostics.json`. `<tokpath>` is the file's path with the
// toolchain or project root replaced (`toolchain/packages/c64/src/index.8bs`),
// so two checkouts at different paths give the same tree.
//
// What is dumped is what the linker sees for one module (linker/index.mjs
// parseModule): tokenize, parse, then bind, with the syntax tree taken before
// bind, because bind and everything after it mutate nodes in place. Media files
// (.8bg, .8ba) have no syntax tree; they dump tokens and diagnostics only.
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeMedia, bind, isMediaKind, parse, sourceKindOf, tokenize } from '../../packages/compiler/index.mjs';
import { canonicalJson, tokenStem } from '../../packages/cli/src/stage-dump.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git']);

/** Ordinal string compare, the same on every machine and locale. */
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Every source file under `base`, outside node_modules, dist and .git, as absolute paths sorted ordinally. */
export function findSources(base) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile() && sourceKindOf(entry.name)) {
        found.push(path);
      }
    }
  };
  walk(base);
  return found.sort(compare);
}

/**
 * The stages of one file as canonical text, `{ tokens, ast, diagnostics }`;
 * `ast` is null for a media file.
 *
 * @param {string} file  Absolute path.
 * @param {string} text
 * @param {{ toolchain?: string|string[], project?: string|string[] }} roots
 */
export function frontendOf(file, text, roots) {
  const sourceKind = sourceKindOf(file) ?? '.8bs';
  if (isMediaKind(sourceKind)) {
    const media = analyzeMedia(text, file, { sourceKind });
    return {
      tokens: canonicalJson(media.tokens, roots), ast: null, diagnostics: canonicalJson(media.diagnostics, roots),
    };
  }
  const { tokens, diagnostics: lexical } = tokenize(text, file, { sourceKind });
  const { ast, diagnostics: syntax } = parse(tokens, text, file, { sourceKind });
  // Written now, before bind runs: bind mutates the tree in place.
  const tokenText = canonicalJson(tokens, roots);
  const astText = canonicalJson(ast, roots);
  const bound = bind(ast, file);
  return {
    tokens: tokenText, ast: astText, diagnostics: canonicalJson([...lexical, ...syntax, ...bound.diagnostics], roots),
  };
}

/** The directory (relative to the output) of one file's dump, from its tokenized path. */
export function dumpDirOf(file, roots, id) {
  const tokenized = tokenStem(file, roots);
  // A project's files sit under its own id, so two projects never share a path.
  const stem = id && tokenized.startsWith('project/') ? `project/${id}/${tokenized.slice('project/'.length)}` : tokenized;
  if (stem.split('/').includes('modules')) {
    throw new Error(`${stem}: a directory named "modules" would be read as a build's module directory`);
  }
  return join('fe', ...stem.split('/'));
}

/**
 * Dumps every file of each `{ base, roots }` under `<out>/fe/`. Returns the
 * number of files written.
 *
 * @param {{ files: string[], id?: string, roots: { toolchain?: string|string[], project?: string|string[] } }[]} groups
 * @param {string} out
 */
export function dumpFrontend(groups, out) {
  let written = 0;
  const seen = new Set();
  for (const { files, roots, id } of groups) {
    for (const file of files) {
      const dir = join(out, dumpDirOf(file, roots, id));
      if (seen.has(dir)) throw new Error(`${file}: another source file already dumps to ${dir}`);
      seen.add(dir);
      const stages = frontendOf(file, readFileSync(file, 'utf8'), roots);
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of Object.entries(stages)) {
        if (text === null) continue;
        writeFileSync(join(dir, `${name}.json`), text);
        written++;
      }
    }
  }
  return written;
}

/** A root and its realpath, for path tokens. */
export function rootsFor(toolchain, project) {
  const real = (path) => (path ? realpathSync(path) : path);
  return { toolchain: [toolchain, real(toolchain)], project: project ? [project, real(project)] : [] };
}
