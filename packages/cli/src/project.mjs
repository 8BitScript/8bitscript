// `8bs project [--json]` — the project in the current directory, described
// by the CLI's own loader instead of by anyone's regular expression: its
// programs (the work units an editor lets you run), the machines it
// targets, its locales, its named systems, and — read from the source by
// the compiler, not searched for — the `#define` values each program takes.
//
// The editor reads the JSON form (docs/project/units.md has the shape and
// the reasoning). The table form is for a person at a terminal.
//
// Exit codes: 0 — the project is described (anything wrong *in* it is a
// `problems` entry, not a failure: a program with a typo in its `targets`
// costs the reader that program, not the whole picture); 1 — a config file
// exists and could not be loaded (the JSON still prints, with `configError`);
// 2 — bad arguments. A directory with no config is not an error: it is
// `{ hasConfig: false }` and the one default program.
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { RELEASE_MACHINES, link, resolveImportAliases } from '@8bitscript/compiler';

import { resolveEntryPath } from './build.mjs';
import { applyCheckoutFromArgs } from './checkout.mjs';
import {
  configPathOf, loadConfig, resolveFrameRate, resolveI18n, resolveLocale,
} from './config.mjs';
import { effectiveDefines } from './defines.mjs';
import {
  catalogTags, listedTargets, loadCatalog, projectBaseline, projectHardware, projectProfiles, projectRequires,
  resolveHardware,
} from './hardware.mjs';
import { resolvePrograms } from './programs.mjs';
import { loadMergedSystems } from './systems.mjs';

/** Bumped when a field changes meaning or goes away; adding a field does not bump it. */
export const PROJECT_JSON_VERSION = 1;

/** A systems layer, in the words an editor shows: a project's own, this machine's, or the toolchain's. */
const LAYERS = { project: 'clone', user: 'machine', advertised: 'advertised' };

/**
 * The machine a program's defines are read on: the project's baseline when
 * the program builds for it, else the first machine it builds for.
 *
 * @param {string[]} targets
 * @param {{ target: string }|null} baseline
 * @returns {string|null} null when the program builds for no machine this release has
 */
function discoveryTarget(targets, baseline) {
  if (baseline && targets.includes(baseline.target)) return baseline.target;
  return targets[0] ?? null;
}

/**
 * Link a program's entry on `target`, as `8bs build` would, and report the
 * `#define` calls it reads. The compiler is asked, so a define spelled in a
 * module the entry imports, or behind a machine's twin file, is found; and a
 * program that does not link yields what it found before it stopped, with a
 * problem saying so.
 */
function discoverDefines(config, program, target, { cwd, checkout, frameRate }) {
  const problems = [];
  try {
    const catalog = loadCatalog(target);
    const hardware = resolveHardware(catalog, {
      overrides: {}, profiles: projectProfiles(config, target), defaults: projectHardware(config, target),
    });
    if (!hardware.ok) return { sites: [], problems: [hardware.error] };
    const tags = catalogTags(catalog);
    const locale = resolveLocale(config, { target, tags, projectDir: cwd });
    const i18n = resolveI18n(config, { projectDir: cwd, tags });
    const aliases = resolveImportAliases(config?.imports, cwd);
    if (!locale.ok) return { sites: [], problems: [locale.error] };
    if (!i18n.ok) return { sites: [], problems: [i18n.error] };
    if (!aliases.ok) return { sites: [], problems: [aliases.error] };
    const entry = resolveEntryPath({ entry: program.entry }, target);
    if (!existsSync(entry)) return { sites: [], problems: [`entry ${program.entry} does not exist`] };
    const result = link(readFileSync(entry, 'utf8'), entry, {
      machine: target, tags: hardware.hardware.tags, facts: hardware.hardware.facts, frameRate, checkout,
      bx: config?.bx, locale: locale.locale, i18n: i18n.i18n, importAliases: aliases.importAliases,
      defines: effectiveDefines(program), defineSites: [],
    });
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      problems.push(`${errors.length} error${errors.length === 1 ? '' : 's'} linking for the ${target}, so the defines below may be incomplete: ${errors[0].code} ${errors[0].message}`);
    }
    return { sites: result.defineSites, problems };
  } catch (error) {
    return { sites: [], problems: [`could not read this program's defines: ${error.message}`] };
  }
}

/**
 * The `defines` an editor shows for one program: every name its source
 * reads, with the source's default and the value the config sets (if it
 * does), then any name the config declares that the source never reads.
 */
function mergeDefines(program, sites) {
  const configured = new Map(program.define.map((entry) => [entry.name, entry]));
  const out = sites.map((site) => {
    const set = configured.get(site.name);
    return {
      name: site.name,
      kind: site.kind,
      default: site.default,
      value: set ? set.value : site.default,
      description: set?.description ?? null,
      source: 'source',
    };
  });
  for (const entry of program.define) {
    if (sites.some((site) => site.name === entry.name)) continue;
    out.push({
      name: entry.name, kind: entry.kind, default: null, value: entry.value, description: entry.description, source: 'config-only',
    });
  }
  return out;
}

/**
 * The project in `cwd`, as plain data.
 *
 * @param {{ cwd?: string, checkout?: string|null, defines?: boolean }} [options]
 *   `defines: false` skips reading each program's `#define` calls (which
 *   links every program once); the programs then carry the config's `define`
 *   entries only and `definesRead: false`.
 */
export async function describeProject({ cwd = process.cwd(), checkout = null, defines = true } = {}) {
  const problems = [];
  const path = configPathOf(cwd);
  const config = await loadConfig(cwd, '8bs project');
  const configError = path !== null && config === null
    ? `${basename(path)} could not be loaded (the reason is on stderr)`
    : null;

  const frameRate = resolveFrameRate(config);
  const requires = projectRequires(config);
  const baseline = projectBaseline(config);
  const systems = loadMergedSystems({ config, projectDir: cwd });
  const declared = resolvePrograms(config);
  const listed = listedTargets(config);
  const i18n = resolveI18n(config, { projectDir: cwd });
  for (const [scope, result] of [['frameRate', frameRate], ['requires', requires], ['baseline', baseline], ['systems', systems], ['programs', declared], ['i18n', i18n]]) {
    if (!result.ok) problems.push({ scope, message: result.error });
  }
  const resolvedBaseline = baseline.ok ? baseline.baseline : null;
  const rate = frameRate.ok ? frameRate.frameRate : 60;

  const buildable = (listed ?? RELEASE_MACHINES).filter((id) => RELEASE_MACHINES.includes(id));
  const targets = buildable.map((id) => {
    const own = (config?.targets && !Array.isArray(config.targets)) ? config.targets[id] : undefined;
    return {
      id,
      hardware: projectHardware(config, id),
      profiles: Object.keys(projectProfiles(config, id)),
      locale: own?.locale ?? null,
    };
  });

  const programs = [];
  for (const program of declared.ok ? declared.programs : []) {
    const reachable = (program.targets ?? buildable).filter((id) => buildable.includes(id));
    // A per-machine `entry` object is not one path; whether it exists is not asked.
    const entryIsPath = typeof program.entry === 'string';
    const entryPresent = entryIsPath && existsSync(resolve(cwd, program.entry));
    const entryMissing = entryIsPath && !entryPresent;
    const entry = {
      name: program.name,
      entry: program.entry,
      entryExists: entryIsPath ? entryPresent : null,
      title: program.title,
      description: program.description,
      group: program.group,
      targetsDeclared: program.targets,
      targets: reachable,
      requires: program.requires,
      definesRead: false,
      defines: mergeDefines(program, []),
      problems: [],
    };
    const target = discoveryTarget(reachable, resolvedBaseline);
    if (defines && target && !entryMissing) {
      const found = discoverDefines(config, program, target, { cwd, checkout, frameRate: rate });
      entry.definesRead = true;
      entry.definesReadOn = target;
      entry.defines = mergeDefines(program, found.sites);
      entry.problems.push(...found.problems);
    } else if (defines && entryMissing) {
      entry.problems.push(`entry ${program.entry} does not exist`);
    } else if (defines && !target) {
      entry.problems.push('no machine this release builds for is among this program\'s targets, so its defines were not read');
    }
    programs.push(entry);
  }

  return {
    version: PROJECT_JSON_VERSION,
    hasConfig: path !== null,
    configPath: path,
    configError,
    dir: cwd,
    name: basename(cwd),
    frameRate: rate,
    baseline: resolvedBaseline,
    targetsListed: listed !== null,
    targets,
    locales: i18n.ok && i18n.i18n
      ? { default: i18n.i18n.defaultLocale, fallback: i18n.i18n.fallbackLocale, available: i18n.i18n.locales }
      : null,
    locale: config?.locale ?? null,
    requires: requires.ok ? requires.requires : {},
    programs,
    systems: systems.ok
      ? systems.systems.map((s) => ({
        name: s.name, layer: LAYERS[s.origin] ?? s.origin ?? 'advertised', target: s.target,
        profile: s.profile ?? null, hardware: s.hardware ?? {}, region: s.region ?? 'ntsc',
      }))
      : [],
    problems,
  };
}

/** One line per program, for the table form. */
function printProject(info) {
  const stdout = process.stdout;
  stdout.write(`${info.name}${info.hasConfig ? '' : '  (no 8bitscript.config.8bs here)'}\n`);
  if (info.configError) stdout.write(`  ${info.configError}\n`);
  stdout.write(`  targets: ${info.targets.map((t) => t.id).join(', ')}${info.targetsListed ? '' : '  (every machine this release builds for)'}\n`);
  stdout.write('\nprograms:\n');
  for (const program of info.programs) {
    const heading = program.title ? `${program.name} — ${program.title}` : program.name;
    stdout.write(`  ${heading}${program.group ? `  [${program.group}]` : ''}\n`);
    stdout.write(`    ${program.entry}   (${program.targets.join(', ')})\n`);
    if (program.description) stdout.write(`    ${program.description}\n`);
    for (const define of program.defines) {
      stdout.write(`    --define ${define.name}=${JSON.stringify(define.value)}${define.default !== null && define.default !== define.value ? `  (the source says ${JSON.stringify(define.default)})` : ''}${define.source === 'config-only' ? '  (no #define reads this)' : ''}\n`);
    }
    for (const problem of program.problems) stdout.write(`    ! ${problem}\n`);
  }
  for (const problem of info.problems) stdout.write(`\n! ${problem.scope}: ${problem.message}\n`);
}

/** @returns {Promise<number>} exit code */
export async function project(args) {
  const checkout = applyCheckoutFromArgs(args);
  if (!checkout.ok) {
    process.stderr.write(`8bs project: ${checkout.error}\n`);
    return 2;
  }
  const known = new Set(['--json', '--no-defines']);
  const unknown = args.filter((a, i) => a.startsWith('-') && !known.has(a) && !checkout.consumed.has(i));
  const stray = args.filter((a, i) => !a.startsWith('-') && !checkout.consumed.has(i));
  if (unknown.length > 0 || stray.length > 0) {
    process.stderr.write(`8bs project: unexpected ${unknown[0] ?? stray[0]}\n\nUsage: 8bs project [--json] [--no-defines] [--checkout <dir>]\n`);
    return 2;
  }
  const info = await describeProject({ checkout: checkout.checkout, defines: !args.includes('--no-defines') });
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  else printProject(info);
  return info.configError ? 1 : 0;
}
