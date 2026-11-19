// `8bs migrate`: the one-time converter from the old syntax to the new
// Rust-style syntax (notes/port/p3-frontend-spec.md section 5). It ships once
// and is deleted after the flip, so it stays self-contained: everything it
// needs is in this folder (`print.mjs`, `embedded.mjs`), plus the old
// `tokenize`/`parse` from the compiler and the wasm front end's `check`.
//
// Every conversion is proved before it is kept: the new text is parsed by the
// new front end and its AST must equal the old AST after the normalizer
// (`front_check`). A file that fails the proof is reported and never written.
//
//   8bs migrate [paths] [--check]       .8bs/.8bx sources, in place
//   8bs migrate --embedded <file>...    programs inside JS/TS sources (tests, generators, scripts)
//   8bs migrate --fences <md>...        ```8bs fences in Markdown
//   8bs migrate --all [paths]           all three over the same paths
//   --alias @lib                        an import alias head from the config (repeatable)
//
// `--check` writes nothing and exits 1 on any difference or failure.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { SOURCE_EXTENSIONS, stripSourceExtension, variantsPresent } from '@8bitscript/compiler';
import { check as proveEqual, parse as parseNew, tokenize as tokenizeNew } from '@8bitscript/compiler/front';
import { convertEmbedded, convertFences } from './embedded.mjs';
import { tokenize } from './legacy/lexer.mjs';
import { parse } from './legacy/parser.mjs';
import { UnsupportedError, printProgram } from './print.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'target', '.changeset', '.fleet-out', 'coverage']);
const SOURCE_FILE = /\.8b[sx]$/;
const SCRIPT_FILE = /\.(?:mjs|cjs|js|mts|cts|ts)$/;
const MARKDOWN_FILE = /\.md$/;

const OLD_CONFIG = '8bitscript.config.8bs';
const NEW_CONFIG = '8bitscript.config.ts';

/** Files that must keep their old syntax or are not converted at all. */
function isExcluded(path) {
  const name = basename(path);
  if (name.startsWith('8bitscript.config.')) return true; // renamed by the config step, never parsed
  if (/\.old\.8b[sx]$/.test(name)) return true; // old-syntax pair fixtures
  const parts = path.split(sep).join('/');
  if (/(^|\/)crates\//.test(parts)) return true; // Rust crates' fixtures: new syntax and error corpora
  if (/(^|\/)packages\/cli\/src\/migrate\//.test(parts)) return true; // the converter's own sources
  if (/(^|\/)packages\/cli\/test\/migrate-[^/]*$/.test(parts)) return true; // its fixtures
  if (/(^|\/)docs\/spec\/8bx\.md$/.test(parts)) return true; // a design record kept as the spec was written: fragments, proposals, rejected designs
  return false;
}

/** Every file under `target` (a file or a directory) that `wanted` accepts. */
function collect(target, wanted, found = []) {
  const info = statSync(target);
  if (info.isFile()) {
    if (wanted.test(target)) found.push(target);
    return found;
  }
  for (const name of readdirSync(target).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(target, name);
    if (statSync(path).isDirectory()) collect(path, wanted, found);
    else if (wanted.test(name)) found.push(path);
  }
  return found;
}

/** Every `.8bs`/`.8bx` source that `8bs migrate` would convert under `root`. */
export function sourceFiles(root) {
  return collect(root, SOURCE_FILE).filter((f) => !isExcluded(f));
}

const lineOf = (text, offset) => {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
};

const describe = (text, diagnostic) => {
  const line = diagnostic.start === undefined ? 0 : lineOf(text, diagnostic.start);
  return `${diagnostic.message}${line ? ` (line ${line})` : ''}`;
};

/** Whether `text` is already valid new-syntax source. */
function parsesAsNew(text, file, sourceKind) {
  try {
    const lexed = tokenizeNew(text, file, { sourceKind });
    const parsed = parseNew(lexed.tokens, text, file, { sourceKind });
    return lexed.diagnostics.length + parsed.diagnostics.length === 0;
  } catch {
    return false;
  }
}

/** Whether the new parser's tree for `text` equals the old tree `oldAst`. */
function proves(oldAst, text, file, sourceKind) {
  try {
    return proveEqual({ file, sourceKind, oldAst, newText: text }).equal;
  } catch {
    return false;
  }
}

/**
 * The predicate migrateText takes: true when a relative specifier's module stem
 * exists under more than one source extension next to `file`. `use self::m::x`
 * would then be ambiguous (8BS2217), so the printer keeps the string path.
 * An extension counts as present when the plain file or a machine, tag or
 * locale twin of it exists (the resolver's variantsPresent), as twins count there.
 *
 * @param {string} file
 * @returns {(specifier: string) => boolean}
 */
export function sameStemIn(file) {
  return (specifier) => {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
    const stem = stripSourceExtension(resolve(dirname(file), specifier));
    const present = (ext) => existsSync(stem + ext) || variantsPresent(stem + ext).length > 0;
    return SOURCE_EXTENSIONS.filter(present).length > 1;
  };
}

/**
 * Convert one old-syntax text and prove the result.
 *
 * @param {string} text
 * @param {{ file?: string, sourceKind?: '.8bs'|'.8bx', aliasHeads?: string[], sameStem?: (specifier: string) => boolean }} [options]
 * @returns {{ status: 'converted' | 'already-new' | 'failed' | 'different', text?: string, message?: string }}
 */
export function migrateText(text, options = {}) {
  const file = options.file ?? '<input>';
  const sourceKind = options.sourceKind ?? '.8bs';
  const lexed = tokenize(text, file, { sourceKind });
  const parsed = parse(lexed.tokens, text, file, { sourceKind });
  const diagnostics = [...lexed.diagnostics, ...parsed.diagnostics];
  if (diagnostics.length > 0) {
    if (parsesAsNew(text, file, sourceKind)) return { status: 'already-new' };
    return { status: 'failed', message: `does not parse as old syntax: ${describe(text, diagnostics[0])}` };
  }
  // The old parser recovers from some new-syntax text (`pub mod M { }` reads as three
  // expression statements and a block), so a clean old parse is not proof that the text is old.
  // Text that the new parser accepts with a different tree than the old parser gave is new.
  if (parsesAsNew(text, file, sourceKind) && !proves(parsed.ast, text, file, sourceKind)) {
    return { status: 'already-new' };
  }
  let printed;
  try {
    printed = printProgram(parsed.ast, lexed.tokens, text, { aliasHeads: options.aliasHeads ?? [], sameStem: options.sameStem });
  } catch (error) {
    if (error instanceof UnsupportedError) return { status: 'failed', message: error.message };
    throw error;
  }
  let proof;
  try {
    proof = proveEqual({ file, sourceKind, oldAst: parsed.ast, newText: printed.text });
  } catch (error) {
    return { status: 'different', message: `the new text was not accepted: ${error.message}` };
  }
  if (!proof.equal) {
    const first = proof.differences[0];
    return { status: 'different', message: `AST differs at ${first?.path ?? '?'}` };
  }
  return { status: 'converted', text: printed.text };
}

const parseArgs = (args) => {
  const opts = { check: false, embedded: false, fences: false, all: false, aliasHeads: [], paths: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--embedded') opts.embedded = true;
    else if (arg === '--fences') opts.fences = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--alias') {
      const head = args[i + 1];
      if (!head || head.startsWith('-')) return { error: '--alias needs a head such as @lib' };
      opts.aliasHeads.push(head);
      i += 1;
    } else if (arg.startsWith('-')) return { error: `unknown option ${arg}` };
    else opts.paths.push(arg);
  }
  return opts;
};

/**
 * `8bs migrate`.
 *
 * @param {string[]} args
 * @param {{ out?: (line: string) => void, cwd?: string }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function migrate(args, io = {}) {
  const out = io.out ?? ((line) => process.stdout.write(`${line}\n`));
  const cwd = io.cwd ?? process.cwd();
  const opts = parseArgs(args);
  if (opts.error) {
    process.stderr.write(`8bs migrate: ${opts.error}\n`);
    return 2;
  }
  const roots = (opts.paths.length > 0 ? opts.paths : ['.']).map((p) => resolve(cwd, p));
  const show = (path) => relative(cwd, path) || path;
  const modes = {
    sources: opts.all || !(opts.embedded || opts.fences),
    embedded: opts.all || opts.embedded,
    fences: opts.all || opts.fences,
  };
  const totals = { converted: 0, alreadyNew: 0, failed: 0, different: 0, unchanged: 0 };
  const failures = [];
  const verb = opts.check ? 'would convert' : 'converted';

  const record = (label, result, detail) => {
    if (result === 'failed' || result === 'different') {
      totals[result] += 1;
      failures.push(`${label}: ${detail}`);
      out(`${result === 'failed' ? 'FAILED' : 'DIFFERENCE'} ${label}: ${detail}`);
    }
  };

  if (modes.sources) {
    const all = roots.flatMap((r) => collect(r, SOURCE_FILE));
    // The old config name: the file is plain type-stripped TypeScript, so
    // the rename is the whole conversion.
    for (const file of all.filter((f) => basename(f) === OLD_CONFIG)) {
      const target = join(dirname(file), NEW_CONFIG);
      if (existsSync(target)) {
        record(show(file), 'failed', `${NEW_CONFIG} already exists beside it; delete one of them`);
        continue;
      }
      totals.converted += 1;
      out(`${opts.check ? 'would rename' : 'renamed'} ${show(file)} to ${NEW_CONFIG}`);
      if (!opts.check) {
        writeFileSync(target, readFileSync(file, 'utf8'));
        rmSync(file);
      }
    }
    const files = all.filter((f) => !isExcluded(f));
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const sourceKind = extname(file);
      const result = migrateText(text, { file, sourceKind, aliasHeads: opts.aliasHeads, sameStem: sameStemIn(file) });
      if (result.status === 'already-new') {
        totals.alreadyNew += 1;
        out(`already new syntax ${show(file)}`);
      } else if (result.status === 'converted' && result.text === text) {
        totals.alreadyNew += 1;
        out(`already new syntax ${show(file)}`);
      } else if (result.status === 'converted') {
        totals.converted += 1;
        out(`${verb} ${show(file)}`);
        if (!opts.check) writeFileSync(file, result.text);
      } else record(show(file), result.status, result.message);
    }
  }

  const literalMode = async (kind, wanted, convertFile) => {
    const files = roots.flatMap((r) => collect(r, wanted)).filter((f) => !isExcluded(f));
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // Embedded programs and fences have no file of their own, so the same-stem predicate looks beside the host file.
      // That is acceptable here: a doc or test snippet imports siblings of the file that shows it, and a wrong guess only
      // keeps the string form, which resolves either way now that the resolver (#380) accepts a string path
      // for a module whose stem exists under more than one extension.
      const result = convertFile(text, (body, sourceKind) => migrateText(body, { file, sourceKind, aliasHeads: opts.aliasHeads, sameStem: sameStemIn(file) }));
      for (const failure of result.failures) record(`${show(file)}:${failure.line}`, failure.status, failure.message);
      if (result.converted > 0 || result.unchanged > 0) {
        totals.converted += result.converted;
        totals.unchanged += result.unchanged;
        if (result.converted > 0) out(`${verb} ${result.converted} ${kind} in ${show(file)}`);
        if (!opts.check && result.text !== text) writeFileSync(file, result.text);
      }
    }
  };
  if (modes.embedded) await literalMode('embedded programs', SCRIPT_FILE, convertEmbedded);
  if (modes.fences) await literalMode('fences', MARKDOWN_FILE, convertFences);

  out(
    `${totals.converted} ${verb}, ${totals.alreadyNew} already new syntax, `
    + `${totals.different} differences, ${totals.failed} failures`,
  );
  return totals.different + totals.failed > 0 ? 1 : 0;
}
