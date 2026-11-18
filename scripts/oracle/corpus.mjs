#!/usr/bin/env node
// The oracle corpus runner. It builds every program of every corpus project
// for every target it declares, and writes one sha256 per output file to
// `<out>/sha256.txt`. Two runs of the same toolchain must give the same file,
// whatever directory the checkout lives in, so nothing here lets a path leak
// into a hash.
//
//   node scripts/oracle/corpus.mjs [--sha-only | --dump] --out <dir> [--jobs <n>] [--only <text>]
//
// With --dump, every build also writes its stage dumps (8bs build
// --dump-stages) under `<out>/<project>/<program>/<target>/`, each project's
// release matrix under `<out>/<project>/release/<output file>/`, and the front
// end of every source file under `<out>/fe/<tokpath>/` (frontend.mjs).
// sha256.txt is the same file with or without --dump.
//
// The corpus is the in-repo projects (every directory under packages/ with an
// 8bitscript.config.8bs or .ts) plus the game repos pinned in
// oracle/corpus.json, cloned at their pinned commit into a temporary
// directory and built against this checkout.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, availableParallelism } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dumpFrontend, findSources, rootsFor } from './frontend.mjs';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages', 'cli', 'bin', '8bs.mjs');
const CONFIG_NAMES = new Set(['8bitscript.config.8bs', '8bitscript.config.ts']);
const BUILD_TIMEOUT_MS = 300000;
const GIT_CANDIDATES = ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git']);

/** Ordinal string compare, the same on every machine and locale. */
export const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every directory under `base` that holds a project config, outside
 * node_modules and dist, as `{ id, dir }` sorted by id. The id is the
 * directory relative to `base`, with `/` separators.
 */
export function findProjects(base) {
  const found = [];
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && CONFIG_NAMES.has(e.name))) {
      found.push({ id: relative(base, dir).split(sep).join('/'), dir });
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIPPED_DIRS.has(e.name)) walk(join(dir, e.name));
    }
  };
  walk(base);
  return found.sort((a, b) => compare(a.id, b.id));
}

/** The first git binary in a fixed list of system directories; never found through PATH. */
export function findGit(candidates = GIT_CANDIDATES, exists = existsSync) {
  const found = candidates.find((file) => exists(file));
  if (!found) throw new Error(`git not found in ${candidates.join(', ')}`);
  return found;
}

/** The projects whose id contains `only` (all when null); none matching is an error. */
export function selectProjects(projects, only) {
  const selected = projects.filter((p) => !only || p.id.includes(only));
  if (selected.length === 0) throw new Error(`--only ${only} matches no project`);
  return selected;
}

/** The builds of a project; a project that lists none is an error, not a silent drop. */
export function requireBuilds(project, info) {
  const builds = buildsOf(info);
  if (builds.length === 0) throw new Error(`${project.id}: the project lists no programs or targets`);
  return builds;
}

/** The `<program>/<target>` pairs of an `8bs project --json` document. */
export function buildsOf(info) {
  const builds = [];
  for (const program of info.programs ?? []) {
    for (const target of program.targets ?? []) builds.push({ program: program.name, target });
  }
  return builds;
}

/** The output file named by the `built <path>` line of `8bs build`. */
export function builtPath(stdout) {
  const match = /^built (.+)$/m.exec(stdout);
  return match ? match[1] : null;
}

export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The text of sha256.txt: `<hex>  <id>` per line, sorted by id. */
export function formatSha(entries) {
  const sorted = [...entries].sort((a, b) => compare(a.id, b.id));
  return sorted.map((e) => `${e.sha}  ${e.id}\n`).join('');
}

function cliArgs(extra, checkout) {
  return checkout ? [CLI, ...extra, '--checkout', checkout] : [CLI, ...extra];
}

/** The `--dump-stages <dir>` arguments, or none when the run does not dump. */
export function dumpArgs(dumpDir) {
  return dumpDir ? ['--dump-stages', dumpDir] : [];
}

async function projectInfo(project) {
  const { stdout } = await run(process.execPath, cliArgs(['project', '--json'], project.checkout), {
    cwd: project.dir, maxBuffer: 64 * 1024 * 1024, timeout: BUILD_TIMEOUT_MS,
  });
  return JSON.parse(stdout);
}

async function buildOne(project, { program, target }, out) {
  const id = `${project.id}/${program}/${target}`;
  const dumpDir = out ? join(out, project.id, program, target) : null;
  const args = cliArgs(['build', '--target', target, '--program', program, ...dumpArgs(dumpDir)], project.checkout);
  try {
    const { stdout } = await run(process.execPath, args, {
      cwd: project.dir, maxBuffer: 64 * 1024 * 1024, timeout: BUILD_TIMEOUT_MS,
    });
    const file = builtPath(stdout);
    if (!file) return { id, error: 'no "built <path>" line in the output' };
    return { id, sha: sha256Of(readFileSync(file)) };
  } catch (err) {
    const text = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim().split('\n').slice(0, 5).join('\n');
    return { id, error: text || String(err.message) };
  }
}

/** The project's whole release matrix, its stage dumps under `<out>/<project>/release/`. */
async function releaseOne(project, out) {
  const id = `${project.id}/release`;
  const args = cliArgs(['build', '--release', ...dumpArgs(join(out, project.id, 'release'))], project.checkout);
  try {
    await run(process.execPath, args, { cwd: project.dir, maxBuffer: 64 * 1024 * 1024, timeout: BUILD_TIMEOUT_MS });
    return { id };
  } catch (err) {
    const text = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim().split('\n').slice(0, 5).join('\n');
    return { id, error: text || String(err.message) };
  }
}

/** Run `tasks` (async functions) with at most `limit` in flight. */
async function pool(tasks, limit) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** Clone a game repo at its pinned commit into `dest`; the commit must match. */
function cloneGame(game, dest) {
  const gitBinary = findGit();
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const git = (...args) => execFileSync(gitBinary, args, {
    cwd: dest, env, stdio: 'pipe', timeout: BUILD_TIMEOUT_MS,
  }).toString().trim();
  mkdirSync(dest, { recursive: true });
  git('init', '-q');
  git('fetch', '-q', '--depth', '1', `https://github.com/${game.repo}.git`, game.sha);
  git('checkout', '-q', '--detach', 'FETCH_HEAD');
  const head = git('rev-parse', 'HEAD');
  if (head !== game.sha) throw new Error(`${game.name}: checked out ${head}, expected ${game.sha}`);
}

/** The source files whose front end is dumped: this checkout, and each game's `src/`. */
export function frontendGroups(projects) {
  const groups = [{ files: findSources(ROOT), roots: rootsFor(ROOT) }];
  for (const project of projects.filter((p) => p.checkout)) {
    groups.push({ files: findSources(join(project.dir, 'src')), roots: rootsFor(ROOT, project.dir) });
  }
  return groups;
}

/** Removes what an earlier dump left for the selected projects (and the front end), so runs never mix. */
export function clearDumps(out, selected, withFrontend) {
  for (const project of selected) rmSync(join(out, project.id), { recursive: true, force: true });
  if (withFrontend) rmSync(join(out, 'fe'), { recursive: true, force: true });
}

export function parseArgs(argv) {
  const options = { out: null, jobs: Math.min(4, availableParallelism()), only: null, shaOnly: true, dump: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (argv[i + 1] === undefined) throw new Error(`${arg} expects a value`);
      return argv[++i];
    };
    if (arg === '--sha-only') options.shaOnly = true;
    else if (arg === '--dump') options.dump = true;
    else if (arg === '--out') options.out = resolve(value());
    else if (arg === '--jobs') options.jobs = Math.max(1, Number.parseInt(value(), 10) || 1);
    else if (arg === '--only') options.only = value();
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.out) throw new Error('--out <dir> is required');
  if (options.dump && argv.includes('--sha-only')) throw new Error('--dump and --sha-only exclude each other');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const corpus = JSON.parse(readFileSync(join(ROOT, 'oracle', 'corpus.json'), 'utf8'));
  rmSync(join(options.out, 'sha256.txt'), { force: true });
  const scratch = mkdtempSync(join(tmpdir(), 'oracle-corpus-'));
  try {
    const projects = findProjects(join(ROOT, 'packages')).map((p) => ({ ...p, checkout: null }));
    for (const game of corpus.games) {
      const dir = join(scratch, game.name);
      cloneGame(game, dir);
      projects.push({ id: game.name, dir, checkout: ROOT });
    }
    const selected = selectProjects(projects, options.only);
    if (options.dump) clearDumps(options.out, selected, !options.only);

    // Builds of one project and target share dist/.8bs-last-<target>.json, so
    // they run one after another; different targets and projects overlap.
    const queues = new Map();
    for (const project of selected) {
      for (const build of requireBuilds(project, await projectInfo(project))) {
        const key = `${project.id}\0${build.target}`;
        if (!queues.has(key)) queues.set(key, []);
        queues.get(key).push(() => buildOne(project, build, options.dump ? options.out : null));
      }
    }
    const batches = [...queues.values()].map((queue) => async () => {
      const done = [];
      for (const task of queue) done.push(await task());
      return done;
    });
    const results = (await pool(batches, options.jobs)).flat();
    // Release matrices come after every other build: they share dist/ with them.
    const releases = options.dump
      ? await pool(selected.map((project) => () => releaseOne(project, options.out)), options.jobs)
      : [];

    const failures = [...results, ...releases].filter((r) => r.error);
    for (const f of failures) process.stderr.write(`FAIL ${f.id}\n${f.error}\n`);
    if (failures.length > 0) {
      process.stderr.write(`corpus: ${failures.length} of ${results.length} builds failed\n`);
      process.exitCode = 1;
      return;
    }
    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, 'sha256.txt'), formatSha(results));
    process.stdout.write(`corpus: ${results.length} builds ok\n`);
    if (options.dump && !options.only) {
      const written = dumpFrontend(frontendGroups(projects), options.out);
      process.stdout.write(`corpus: front end dumped, ${written} files\n`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`corpus: ${err.message}\n`);
    process.exit(1);
  });
}

