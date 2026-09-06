// The hardware a build is made for — a machine plus the options fitted to
// it — resolved from the machine package's catalog.
//
// Every machine package declares what can be fitted in its package.json,
// under `"8bitscript".hardware`: a set of *options* (a VIC-20's RAM
// expansion, a C64's control ports and SID, a PET's model, an Atari's
// machine and mouse), each with the values it can take, and *presets*,
// the community names for whole configurations (`8032`, `130xe`,
// `reu512`) that `--profile` accepts. Each value says what fitting it
// changes, in at most four ways:
//
//   tag    the word a `.<machine>.<tag>.8bs` file twin is named with, for
//          code that differs on that hardware (default: the value's own
//          name; the option's default value carries no tag unless it says)
//   build  what the linker needs — `defsym` symbols for the SDK's link
//          script, or a different `driver` and `output` extension
//   run    the flags each emulator takes to fit the same thing, keyed by
//          the emulator's name; `load` overrides how the built file is
//          handed to it, with `{out}` standing for the file
//   facts  what a program can then rely on, as dotted keys (`input.mouse`,
//          `video.columns`) — carried through the build for the fact
//          sheet and the editor's hardware panel
//
// A project's 8bs.config.ts may add named profiles of its own under
// `targets.<machine>.profiles`, each a set of option values; `--profile`
// names one of those or a catalog preset — a project's name shadows a
// preset's — and `--hardware ram=8k,port1=mouse1351` sets options on top
// of whichever was chosen. The result is one object the build, the
// emulator launch, the screenshot path, and `8bs targets` all read.
import { createRequire } from 'node:module';

import { MACHINES } from '@8bitscript/compiler';

const require = createRequire(import.meta.url);

/**
 * The catalog a machine package declares, or an empty one for a machine
 * with nothing to fit (web).
 *
 * @param {string} machine
 * @returns {{ machine: string, options: object, presets: object, facts: object }}
 */
export function loadCatalog(machine) {
  if (!MACHINES.includes(machine)) throw new Error(`no such machine '${machine}'`);
  const pkg = require(`@8bitscript/${machine}/package.json`);
  const hardware = pkg['8bitscript']?.hardware ?? {};
  return {
    machine,
    options: hardware.options ?? {},
    presets: hardware.presets ?? {},
    facts: hardware.facts ?? {},
  };
}

/**
 * The stock machine's fact sheet: what `8bs build <machine>` with no
 * profile and no `--hardware` hands the compiler. Tests link against it.
 *
 * @param {string} machine
 * @returns {object} facts, keyed as the compiler's FACTS table is
 */
export function stockFacts(machine) {
  return resolveHardware(loadCatalog(machine), {}).hardware.facts;
}

/**
 * `ram=8k,port1=mouse1351` → `{ ram: '8k', port1: 'mouse1351' }`. Several
 * `--hardware` arguments may be given; join their texts with commas.
 *
 * @param {string} text
 * @returns {{ ok: true, overrides: object } | { ok: false, error: string }}
 */
export function parseHardwareArg(text) {
  const overrides = {};
  for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([A-Za-z0-9_-]+)=([A-Za-z0-9_.-]+)$/.exec(part);
    if (!m) return { ok: false, error: `--hardware expects option=value pairs separated by commas, got '${part}'` };
    overrides[m[1]] = m[2];
  }
  return { ok: true, overrides };
}

/**
 * The project's own profiles for a machine, from an 8bs.config.ts whose
 * `targets` is the object form: `{ c64: { profiles: { loaded: { ram:
 * 'reu512' } } } }`. The array form has none.
 *
 * @param {object|null} config
 * @param {string} machine
 * @returns {object} profile name → option values
 */
export function projectProfiles(config, machine) {
  const targets = config?.targets;
  if (!targets || Array.isArray(targets)) return {};
  return targets[machine]?.profiles ?? {};
}

/**
 * The hardware a project fits one target with by default — its own stock
 * for that machine, applied under any named profile and any `--hardware`:
 * `targets: { pet: { hardware: { model: '8032' } } }` makes every PET
 * build of this project an 80-column one unless a build says otherwise.
 *
 * @param {object|null} config
 * @param {string} machine
 * @returns {object} option → value
 */
export function projectHardware(config, machine) {
  const targets = config?.targets;
  if (!targets || Array.isArray(targets)) return {};
  return targets[machine]?.hardware ?? {};
}

/**
 * The targets a project's config lists, in either form, or null for
 * "every target" when it lists none.
 *
 * @param {object|null} config
 * @returns {string[]|null}
 */
export function listedTargets(config) {
  const targets = config?.targets;
  if (!targets) return null;
  return Array.isArray(targets) ? targets : Object.keys(targets);
}

/**
 * Resolve the hardware for one build.
 *
 * @param {{ machine: string, options: object, presets: object, facts: object }} catalog
 * @param {{ profile?: string, overrides?: object, profiles?: object, defaults?: object }} [choice]
 *   `defaults` are the project's own values for this machine (from
 *   projectHardware()), applied over the catalog's; `profile` names a
 *   project profile (`profiles`, from projectProfiles()) or, failing that,
 *   a catalog preset, applied over those; `overrides` are option values
 *   set on top of everything (`--hardware`).
 * @returns {{ ok: true, hardware: Hardware } | { ok: false, error: string }}
 *
 * @typedef {{
 *   machine: string, profile: string|null, options: object, tags: string[],
 *   buildValues: string[], build: { defsym: object, driver?: string, output?: string },
 *   run: object, load: object, facts: object, label: string,
 * }} Hardware
 *   `options` is every option's chosen value; `tags` the file-twin tags
 *   those values carry; `buildValues` the non-default values that change
 *   the build, in catalog order — what an output filename carries; `build`
 *   the merged linker effects; `run`/`load` per-emulator flag lists;
 *   `facts` the merged facts; `label` a short human spelling.
 */
export function resolveHardware(catalog, { profile, overrides = {}, profiles = {}, defaults = {} } = {}) {
  const { machine, options: catalogOptions, presets } = catalog;
  const named = (name) => {
    if (name === undefined) return { ok: true, values: {} };
    if (Object.hasOwn(profiles, name)) return { ok: true, values: profiles[name], from: 'this project' };
    if (Object.hasOwn(presets, name)) return { ok: true, values: presets[name], from: 'the catalog' };
    const known = [...Object.keys(profiles), ...Object.keys(presets)];
    return {
      ok: false,
      error: known.length > 0
        ? `unknown ${machine} profile '${name}'. Profiles: ${known.join(', ')} (a project's profile shadows a catalog preset of the same name)`
        : `the ${machine} has no profiles to choose from; use --hardware option=value instead`,
    };
  };
  const base = named(profile);
  if (!base.ok) return base;

  const options = {};
  for (const [id, option] of Object.entries(catalogOptions)) options[id] = option.default;
  for (const [source, values] of [['this project\'s hardware', defaults], ['profile', base.values], ['--hardware', overrides]]) {
    for (const [id, value] of Object.entries(values)) {
      const option = catalogOptions[id];
      if (!option) {
        return { ok: false, error: `the ${machine} has no '${id}' option (from ${source}). Options: ${Object.keys(catalogOptions).join(', ') || 'none'}` };
      }
      if (!Object.hasOwn(option.values, String(value))) {
        return { ok: false, error: `'${value}' is not a value the ${machine}'s '${id}' option takes (from ${source}). Values: ${Object.keys(option.values).join(', ')}` };
      }
      options[id] = String(value);
    }
  }

  const tags = [];
  const buildValues = [];
  const build = { defsym: {} };
  const run = {};
  const load = {};
  const facts = { ...catalog.facts };
  const labels = [];
  for (const [id, option] of Object.entries(catalogOptions)) {
    const value = options[id];
    const entry = option.values[value];
    const isDefault = value === option.default;
    if (Object.hasOwn(entry, 'tag') ? entry.tag !== null : !isDefault) tags.push(entry.tag ?? value);
    if (entry.build) {
      if (!isDefault) buildValues.push(value);
      Object.assign(build.defsym, entry.build.defsym ?? {});
      if (entry.build.driver) build.driver = entry.build.driver;
      if (entry.build.output) build.output = entry.build.output;
    }
    for (const [emulator, args] of Object.entries(entry.run ?? {})) run[emulator] = [...(run[emulator] ?? []), ...args];
    for (const [emulator, args] of Object.entries(entry.load ?? {})) load[emulator] = args;
    Object.assign(facts, entry.facts ?? {});
    if (!isDefault) labels.push(`${id}=${value}`);
  }
  return {
    ok: true,
    hardware: {
      machine, profile: profile ?? null, options, tags, buildValues, build, run, load, facts,
      label: labels.length > 0 ? labels.join(' ') : 'stock',
    },
  };
}

/**
 * The `--profile <name>` and `--hardware option=value,...` arguments of a
 * `8bs build`/`8bs run` line — `--hardware` may repeat — and which
 * argument positions they took, so the caller can leave them out of its
 * positionals.
 *
 * @param {string[]} args
 * @returns {{ ok: true, profile?: string, overrides: object, consumed: Set<number> } | { ok: false, error: string }}
 */
export function hardwareArgs(args) {
  const consumed = new Set();
  let profile;
  const overrides = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--profile') {
      if (args[i + 1] === undefined) return { ok: false, error: '--profile expects a name' };
      profile = args[i + 1];
      consumed.add(i).add(i + 1);
    } else if (args[i] === '--hardware') {
      if (args[i + 1] === undefined) return { ok: false, error: '--hardware expects option=value pairs' };
      const parsed = parseHardwareArg(args[i + 1]);
      if (!parsed.ok) return parsed;
      Object.assign(overrides, parsed.overrides);
      consumed.add(i).add(i + 1);
    }
  }
  return { ok: true, profile, overrides, consumed };
}

/** The usage lines both commands print for the hardware arguments. */
export const HARDWARE_USAGE = '                 [--profile <name>]            a catalog preset or a project profile — `8bs targets` lists them\n'
  + '                 [--hardware option=value,...] single options on top (e.g. --hardware ram=8k,port1=mouse1351)\n';

/**
 * `hardware.load[emulator]` with `{out}` filled in, or the emulator's own
 * default way of taking the file.
 */
export function loadArgs(hardware, emulator, outFile, fallback) {
  const template = hardware?.load?.[emulator];
  if (!template) return fallback;
  return template.map((arg) => arg.replaceAll('{out}', outFile));
}
