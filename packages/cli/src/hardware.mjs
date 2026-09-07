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
// and `detect` names the package subpath whose probe finds that hardware
// on the machine at run time (`@8bitscript/c64/reu`). It sits on the
// option when one probe finds every value of it — one build then serves
// them all — or on a single value when only that one can be found: an
// Atari 130XE's extra RAM can be, an 800XL's absence of it needs no
// probe, and a `xegs` cartridge is a different binary either way. Without
// `detect` a value is chosen at build time, each its own build (a PET
// model, a VIC-20 expansion that moves the screen). Fitting the hardware
// for a build is the opt-in: it compiles the probe's caller in and sets
// the fact to "may use", and the probe confirms it on the machine.
//
// A project's 8bs.config.ts may add named profiles of its own under
// `targets.<machine>.profiles`, each a set of option values; `--profile`
// names one of those or a catalog preset — a project's name shadows a
// preset's — and `--hardware ram=8k,port1=mouse1351` sets options on top
// of whichever was chosen. The result is one object the build, the
// emulator launch, the screenshot path, and `8bs targets` all read.
// One thing to know when reading a catalog: an option value whose name is
// all digits (`1541`, a PET's `8032`) is a canonical array index to
// JavaScript, so `Object.keys` hands those back first, in numeric order,
// ahead of every name with a letter in it. Nothing here depends on the
// order of *values* — facts merge per option, and `buildValues` only ever
// holds values that carry a `build` — but a list printed from one is not
// in the order the package.json writes it, and that is why.
import { createRequire } from 'node:module';

import { MACHINES, requiresProblems, unmetRequirements } from '@8bitscript/compiler';

const require = createRequire(import.meta.url);

/**
 * The catalog a machine package declares, or an empty one for a machine
 * with nothing to fit (web).
 *
 * @param {string} machine
 * @returns {{ machine: string, options: object, presets: object, facts: object, run: object }}
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
    run: hardware.run ?? {},
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
 * The floor a program sets: `requires` in its 8bs.config.ts, a fact key to
 * the least of it the program needs.
 *
 *     requires: { 'memory.ram': 8192, 'storage.save': true }
 *
 * The machines are not alike, and this is where a program says which of
 * the differences it cannot live with. A count is a floor and a flag must
 * be true, checked against the sheet the build resolves to — so "needs 8K"
 * is a sentence about the program, answered before the compiler runs,
 * instead of a linker overflow at the end of one.
 *
 * @param {object|null} config
 * @returns {{ ok: true, requires: object } | { ok: false, error: string }}
 */
export function projectRequires(config) {
  const requires = config?.requires;
  if (requires === undefined) return { ok: true, requires: {} };
  if (requires === null || typeof requires !== 'object' || Array.isArray(requires)) {
    return { ok: false, error: "8bs.config.ts's `requires` must be an object of fact → the least of it the program needs" };
  }
  const problems = requiresProblems(requires);
  if (problems.length > 0) {
    return { ok: false, error: `8bs.config.ts's \`requires\`: ${problems.join('; ')}` };
  }
  return { ok: true, requires };
}

/**
 * What this machine could be fitted with that would meet a requirement the
 * build does not — the half of the message that makes it actionable, since
 * "needs 8192 bytes" on a stock VIC-20 is only useful beside "ram=8k gives
 * 28671".
 *
 * Every value of every option is resolved on top of the choice already
 * made, so what comes back is one change away, not a different machine.
 *
 * @param {object} catalog
 * @param {string} key   the fact that fell short
 * @param {number|boolean} need
 * @param {object} [choice] the same shape resolveHardware takes
 * @returns {string[]} `option=value gives N`, in catalog order
 */
export function whatSatisfies(catalog, key, need, choice = {}) {
  const found = [];
  for (const [id, option] of Object.entries(catalog.options ?? {})) {
    for (const value of Object.keys(option.values ?? {})) {
      const resolved = resolveHardware(catalog, {
        ...choice,
        overrides: { ...choice.overrides, [id]: value },
      });
      if (!resolved.ok) continue;
      const have = resolved.hardware.facts[key];
      if (unmetRequirements({ [key]: need }, resolved.hardware.facts).length === 0) {
        found.push(`${id}=${value} gives ${have === true ? 'it' : have}`);
      }
    }
  }
  return found;
}

/** The machines whose emulator takes a region; `--pal` means nothing elsewhere. */
export const REGION_MACHINES = new Set(['vic20', 'c64', 'c128', 'mega65', 'atari8']);

/**
 * The machines a project has been *set up for*: its `systems` block, each
 * entry one of its targets with the hardware already fitted.
 *
 * This is the layer above `targets`. A program is normally written for
 * every machine — `targets` stays the whole list — but some hardware is
 * always a choice rather than a fact of the machine: a mouse or a stick in
 * a port, how much RAM is in the expansion, which drive is attached. A
 * `systems` entry names one such arrangement, so a person picks *"C64 with
 * a mouse"* instead of assembling `--profile`/`--hardware` from the
 * catalog each time, and the editor lists it ready to run:
 *
 *     systems: {
 *       'C64 with a mouse': { target: 'c64', hardware: { port1: 'mouse1351' } },
 *       'Expanded VIC-20':  { target: 'vic20', profile: '8k' },
 *       'X16':              { target: 'cx16' },
 *     }
 *
 * `profile` names a catalog preset or one of that machine's own profiles
 * and `hardware` sets options on top, exactly as `--profile` and
 * `--hardware` do — an entry is the command line, written down. `region`
 * is `'ntsc'` or `'pal'` for the machines that have one.
 *
 * Every entry is checked here rather than where it is used: a name in the
 * config that quietly fails to appear in the editor is worse than an
 * error, so a bad entry fails the whole block.
 *
 * @param {object|null} config
 * @returns {{ ok: true, systems: SystemSetup[] } | { ok: false, error: string }}
 *
 * @typedef {{
 *   name: string, target: string, profile: string|null,
 *   hardware: object, region: 'ntsc'|'pal'|null, label: string,
 * }} SystemSetup
 */
export function projectSystems(config) {
  const declared = config?.systems;
  if (declared === undefined) return { ok: true, systems: [] };
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
    return { ok: false, error: "8bs.config.ts's `systems` must be an object of name → { target, ... }" };
  }
  const listed = listedTargets(config);
  // The floor, but only once it is a floor: an unchecked `requires` would
  // have every system marked short over a key the CLI is about to refuse
  // — and `requires: ['memory.ram']` would ask the sheet for a fact named
  // '0'. A config with a bad block gets its error, and its systems get no
  // verdict rather than a wrong one.
  const required = projectRequires(config);
  const floor = required.ok ? required.requires : {};
  const systems = [];
  for (const [name, entry] of Object.entries(declared)) {
    const where = `8bs.config.ts: system '${name}'`;
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: `${where} must be an object with a target` };
    }
    // A system is offered beside the bare machines, in one list. A name
    // that is already a machine's would be two entries answering to the
    // same word, and the wrong one would win.
    if (MACHINES.includes(name)) {
      return { ok: false, error: `${where}: '${name}' is a machine's own name; call the system something else` };
    }
    const { target, profile, hardware = {}, region = null } = entry;
    if (!MACHINES.includes(target)) {
      return { ok: false, error: `${where}: '${target}' is not a machine. Machines: ${MACHINES.join(', ')}` };
    }
    if (listed && !listed.includes(target)) {
      return { ok: false, error: `${where}: this project does not target ${target}. Targets: ${listed.join(', ')}` };
    }
    if (region !== null && region !== 'ntsc' && region !== 'pal') {
      return { ok: false, error: `${where}: region must be 'ntsc' or 'pal', got ${JSON.stringify(region)}` };
    }
    if (region !== null && !REGION_MACHINES.has(target)) {
      return { ok: false, error: `${where}: the ${target} has no region to pick; leave it out` };
    }
    // The entry has to resolve the way the build will resolve it, or the
    // editor offers a machine that cannot be run. `profile: null` is
    // written out by anything that fills the shape in mechanically, and
    // means the same as leaving it out — not a profile called "null".
    const resolved = resolveHardware(loadCatalog(target), {
      profile: profile ?? undefined,
      overrides: hardware,
      profiles: projectProfiles(config, target),
      defaults: projectHardware(config, target),
    });
    if (!resolved.ok) return { ok: false, error: `${where}: ${resolved.error}` };
    systems.push({
      name,
      target,
      profile: profile ?? null,
      hardware: Object.fromEntries(Object.entries(hardware).map(([k, v]) => [k, String(v)])),
      region,
      label: resolved.hardware.label,
      // What this arrangement falls short of, if the program set a floor.
      // A system that cannot run the program is still listed — it is in
      // the config, and silently dropping it would be the debugging trap
      // this function exists to avoid — but it is listed as such.
      unmet: unmetRequirements(floor, resolved.hardware.facts),
    });
  }
  return { ok: true, systems };
}

/**
 * Resolve the hardware for one build.
 *
 * @param {{ machine: string, options: object, presets: object, facts: object, run?: object }} catalog
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
  // Stock-machine emulator flags (the X16's mouse grab, etc.), after the
  // option values so a value can still prepend its own flags.
  for (const [emulator, args] of Object.entries(catalog.run ?? {})) {
    run[emulator] = [...(run[emulator] ?? []), ...args];
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
