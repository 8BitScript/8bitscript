// Stage dumps: the canonical writer behind `8bs build --dump-stages <dir>` and
// the EIGHTBS_DUMP_STAGES environment variable.
//
// The compiler's `dump(stage, value, key)` callback hands over each stage's
// value as the build reaches it. Those values are LIVE: `bytes` arrives before
// the file is written, and the backend input holds the very arrays that are
// about to be lowered. So the writer here is strictly read-only. Every value
// is turned into text synchronously, inside the callback, and nothing is
// mutated, sorted in place, or kept by reference. The files are written once
// the build is over.
//
// The format is canonical, so that a second implementation can write the same
// bytes (see notes/port, "Canonical format"):
//   - JSON with two-space indent and a final newline;
//   - every object's keys sorted ordinally (UTF-16 code units), whatever the
//     engine's own key order is (it puts integer-like keys first);
//   - `undefined` object members are dropped; a Map is an object whose keys
//     must be strings; a Set is an array in insertion order; a typed array is
//     an array of numbers;
//   - `NaN`, `Infinity`, `-0`, functions, symbols, bigints and cycles throw;
//   - an absolute path under the toolchain or the project becomes
//     `<toolchain>/...` or `<project>/...`;
//   - `bytes.hex` is lowercase hex, 16 bytes a line.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

export const ENV_NAME = 'EIGHTBS_DUMP_STAGES';

/** Ordinal string compare: UTF-16 code units, the same on every machine. */
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const STAGE_FILES = {
  diagnostics: 'diagnostics.json',
  'linked-ir': 'linked.json',
  'backend-input': 'backend-input.json',
  'wasm-input': 'wasm-input.json',
  link: 'link.json',
  bytes: 'bytes.hex',
  'size-report': 'size-report.json',
  debug: 'debug.json',
  listing: 'listing.json',
  remarks: 'remarks.json',
  error: 'error.txt',
};
const MODULE_SUFFIX = { tokens: '.tokens.json', ast: '.ast.json', 'module-ir': '.ir.json' };

/** A path with `/` separators on every platform. */
function slashed(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

/** The roots as lists of candidate prefixes (a root and its realpath), longest first. */
function candidates(root) {
  const list = (Array.isArray(root) ? root : [root]).filter(Boolean).map(slashed);
  return [...new Set(list)].sort((a, b) => b.length - a.length || compare(a, b));
}

/**
 * Replaces an absolute prefix with `<toolchain>` or `<project>`, the toolchain
 * first. Only a whole path segment matches: `/r/tcx/y` is not under `/r/tc`.
 *
 * @param {string} path
 * @param {{ toolchain?: string|string[], project?: string|string[] }} roots
 */
export function tokenizePath(path, roots) {
  const text = slashed(path);
  for (const [root, token] of [[roots.toolchain, '<toolchain>'], [roots.project, '<project>']]) {
    for (const prefix of candidates(root)) {
      if (text === prefix) return token;
      if (text.startsWith(`${prefix}/`)) return `${token}${text.slice(prefix.length)}`;
    }
  }
  return path;
}

/** The module-file stem of a tokenized path: `<toolchain>/a/b.8bs` becomes `toolchain/a/b.8bs`. */
export function tokenStem(path, roots) {
  const token = tokenizePath(path, roots);
  const named = /^<(toolchain|project)>(.*)$/.exec(token);
  if (named) return `${named[1]}${named[2]}`;
  return `external/${slashed(token).replace(/^\/+/, '').replace(':', '')}`;
}

/** `bytes.hex`: lowercase hex, 16 bytes a line, one space between bytes. */
export function hexDump(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const words = [];
    for (let j = i; j < Math.min(i + 16, bytes.length); j++) words.push(bytes[j].toString(16).padStart(2, '0'));
    lines.push(words.join(' '));
  }
  return lines.map((line) => `${line}\n`).join('');
}

const escapePointer = (segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1');

class DumpError extends Error {
  constructor(message, path) {
    super(`stage dump: ${message} at /${path.map(escapePointer).join('/')}`);
    this.name = 'DumpError';
  }
}

/** The members of an object-like value as sorted `[key, value]` pairs, `undefined` dropped. */
function membersOf(value, path) {
  let entries;
  if (value instanceof Map) {
    entries = [...value];
    for (const [key] of entries) {
      if (typeof key !== 'string') throw new DumpError(`Map key of type ${typeof key}`, path);
    }
  } else {
    entries = Object.keys(value).map((key) => [key, value[key]]);
  }
  return entries.filter(([, member]) => member !== undefined).sort((a, b) => compare(a[0], b[0]));
}

/** The items of an array-like value: an array, a Set (insertion order) or a typed array. */
function itemsOf(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  return Array.from(value);
}

function isSequence(value) {
  return Array.isArray(value) || value instanceof Set || ArrayBuffer.isView(value);
}

function primitiveText(value, path, roots) {
  switch (typeof value) {
    case 'string': return JSON.stringify(tokenizePath(value, roots));
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new DumpError(`${value} is not a finite number`, path);
      if (Object.is(value, -0)) throw new DumpError('-0 is not allowed', path);
      return String(value);
    case 'undefined': return 'null';
    default:
      if (value === null) return 'null';
      throw new DumpError(`a ${typeof value} cannot be written`, path);
  }
}

/**
 * The canonical text of `value`, without the final newline. Read-only: the
 * value is walked once and only read.
 */
function writeValue(value, ctx, depth) {
  if (value === null || typeof value !== 'object') return primitiveText(value, ctx.path, ctx.roots);
  if (ctx.open.has(value)) throw new DumpError('cycle', ctx.path);
  ctx.open.add(value);
  try {
    return isSequence(value) ? writeSequence(value, ctx, depth) : writeObject(value, ctx, depth);
  } finally {
    ctx.open.delete(value);
  }
}

function writeSequence(value, ctx, depth) {
  const items = itemsOf(value);
  if (items.length === 0) return '[]';
  const pad = '  '.repeat(depth + 1);
  const parts = items.map((item, i) => {
    ctx.path.push(i);
    const text = writeValue(item, ctx, depth + 1);
    ctx.path.pop();
    return `${pad}${text}`;
  });
  return `[\n${parts.join(',\n')}\n${'  '.repeat(depth)}]`;
}

function writeObject(value, ctx, depth) {
  const members = membersOf(value, ctx.path);
  if (members.length === 0) return '{}';
  const pad = '  '.repeat(depth + 1);
  const parts = members.map(([key, member]) => {
    ctx.path.push(key);
    const text = writeValue(member, ctx, depth + 1);
    ctx.path.pop();
    return `${pad}${JSON.stringify(key)}: ${text}`;
  });
  return `{\n${parts.join(',\n')}\n${'  '.repeat(depth)}}`;
}

/**
 * `JSON.stringify(sortKeys(value), null, 2) + "\n"`, with the rules above.
 *
 * @param {unknown} value
 * @param {{ toolchain?: string|string[], project?: string|string[] }} [roots]
 * @returns {string}
 */
export function canonicalJson(value, roots = {}) {
  return `${writeValue(value, { roots, path: [], open: new Set() }, 0)}\n`;
}

/** The dump file (relative to the build's directory) a stage's value goes to. */
export function stageFile(stage, key, roots) {
  const suffix = MODULE_SUFFIX[stage];
  if (suffix) {
    if (typeof key !== 'string') throw new Error(`stage dump: ${stage} needs the module path as its key`);
    return `modules/${tokenStem(key, roots)}${suffix}`;
  }
  const file = STAGE_FILES[stage];
  if (!file) throw new Error(`stage dump: unknown stage '${stage}'`);
  return file;
}

/** The text of one stage: hex for bytes, the string itself for an error, canonical JSON otherwise. */
export function stageText(stage, value, roots) {
  if (stage === 'bytes') return hexDump(value);
  if (stage === 'error') return String(value);
  return canonicalJson(value, roots);
}

/**
 * One build's dump. `dump` is the callback to hand the compiler; it serializes
 * at once and keeps text, never the value. `flush` writes the files and the
 * manifest.
 *
 * @param {{ toolchain?: string|string[], project?: string|string[] }} roots
 */
export function createStageDump(roots) {
  /** @type {Map<string, string>} relative file → text */
  const files = new Map();
  /** @type {Set<string>} stage ids in emission order */
  const stages = new Set();
  const dump = (stage, value, key) => {
    files.set(stageFile(stage, key, roots), stageText(stage, value, roots));
    stages.add(stage);
  };
  const flush = (dir, { target, machine, program, locale }) => {
    const manifest = canonicalJson({ target, machine, program, locale: locale ?? null, stages: [...stages] }, roots);
    const all = [...files, ['manifest.json', manifest]];
    for (const [rel, text] of all) {
      const file = join(dir, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    return all.length;
  };
  return { dump, flush, files, stages };
}

/**
 * `--dump-stages <dir>` out of the build arguments; the flag wins over the
 * environment variable.
 *
 * @param {string[]} args
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ ok: true, dir: string|undefined, consumed: number[] } | { ok: false, error: string }}
 */
export function dumpStagesArg(args, env = process.env) {
  const index = args.indexOf('--dump-stages');
  if (index < 0) return { ok: true, dir: env[ENV_NAME] || undefined, consumed: [] };
  if (index + 1 >= args.length || args[index + 1].startsWith('-')) {
    return { ok: false, error: '--dump-stages expects a directory' };
  }
  return { ok: true, dir: args[index + 1], consumed: [index, index + 1] };
}

/**
 * A dump session for one `compile()`: the callback to hand the compiler, a
 * `note` for facts only the build knows (program, locale, output file), and
 * `finish`, which writes the files once the build is over, failed or not.
 *
 * `spec` is a directory, or `{ dir, perOutput: true }` for a release, where
 * each output gets `<dir>/<output file basename>/`.
 *
 * @param {string | { dir: string, perOutput?: boolean }} spec
 * @param {{ toolchain?: string|string[], project?: string|string[] }} roots
 */
export function openDump(spec, roots) {
  const { dir, perOutput = false } = typeof spec === 'string' ? { dir: spec } : spec;
  const writer = createStageDump(roots);
  const meta = {};
  const note = (facts) => Object.assign(meta, facts);
  const finish = (target) => {
    const outputName = meta.output ? basename(meta.output) : `${meta.program ?? 'program'}-${target}`;
    const sub = perOutput ? join(dir, outputName) : dir;
    return writer.flush(sub, { target, machine: target, program: meta.program, locale: meta.locale });
  };
  return { dump: writer.dump, note, finish };
}
