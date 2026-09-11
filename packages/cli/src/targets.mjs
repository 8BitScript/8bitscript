// `8bs targets [--json]` — every machine the toolchain builds for, and the
// hardware each can be fitted with: the catalog every machine package
// declares (packages/cli/src/hardware.mjs), plus the profiles the project
// in the current directory composes in its 8bitscript.config.ts, and the whole
// machines that config has been set up for in its `systems` block. The
// editor reads the JSON form to build its System and Hardware controls, so
// a new machine or option in a package — or a new system in a project — is
// a new row there with nothing to update by hand.
import { FACTS, MACHINES, RELEASE_MACHINES } from '@8bitscript/compiler';

import { loadConfig } from './config.mjs';
import {
  REGION_MACHINES, loadCatalog, projectHardware, projectProfiles, projectRequires, projectSystems,
  stockFacts,
} from './hardware.mjs';
import { VICE_EMULATOR } from './run.mjs';

const EMULATOR = {
  ...VICE_EMULATOR, atari8: 'atari800', nes: 'fceux', cx16: 'x16emu', mega65: 'xmega65', web: 'the browser',
};
const TITLE = {
  vic20: 'Commodore VIC-20', c64: 'Commodore 64', pet: 'Commodore PET', c128: 'Commodore 128',
  atari8: 'Atari 8-bit', nes: 'Nintendo Entertainment System', cx16: 'Commander X16', mega65: 'MEGA65', web: 'Web',
};

/**
 * One entry per target: what the editor's dropdowns and hardware panel
 * are built from.
 *
 * @param {object|null} config the project's 8bitscript.config.ts, if any
 */
export function describeTargets(config) {
  return MACHINES.map((id) => {
    const catalog = loadCatalog(id);
    const options = Object.fromEntries(Object.entries(catalog.options).map(([optionId, option]) => [optionId, {
      label: option.label,
      default: option.default,
      // The package subpath whose probe finds this hardware on the machine
      // at run time, when one probe finds every value of the option; a
      // value may name its own instead (see below). Null when the choice
      // is the build's (a PET model).
      detect: option.detect ?? null,
      values: Object.fromEntries(Object.entries(option.values).map(([value, entry]) => [value, {
        label: entry.label,
        affectsBuild: Boolean(entry.build),
        // What finds *this* value at run time: its own probe, or the
        // option's when one probe covers them all.
        detect: entry.detect ?? option.detect ?? null,
        tag: Object.hasOwn(entry, 'tag') ? entry.tag : (value === option.default ? null : value),
        facts: entry.facts ?? {},
      }])),
    }]));
    return {
      id,
      title: TITLE[id],
      // Whether this release builds for the machine. Every machine is
      // listed so the editor can still show its catalog and a program
      // written for it still checks; only `8bs build` refuses the parked
      // ones (RELEASE_MACHINES in the compiler).
      inRelease: RELEASE_MACHINES.includes(id),
      emulator: EMULATOR[id],
      region: REGION_MACHINES.has(id),
      options,
      presets: catalog.presets,
      profiles: projectProfiles(config, id),
      // The project's own default values for this machine, under any profile.
      hardware: projectHardware(config, id),
      // The stock machine's sheet; a chosen value's `facts` change it, in
      // option order, the way resolveHardware merges them.
      facts: stockFacts(id),
    };
  });
}

/** The fact keys, typed and described, so the editor's sheet labels itself from one place. */
export function describeFacts() {
  return [...FACTS].map(([key, fact]) => ({ key, ...fact }));
}

/** One line per system a config declares, for the table form. */
function printSystems(systems) {
  if (systems.length === 0) return;
  process.stdout.write('\nThis project is set up for:\n');
  for (const system of systems) {
    const parts = [
      system.profile && `--profile ${system.profile}`,
      Object.entries(system.hardware).length > 0
        && `--hardware ${Object.entries(system.hardware).map(([k, v]) => `${k}=${v}`).join(',')}`,
      system.region === 'pal' && '--pal',
    ].filter(Boolean);
    process.stdout.write(`  ${system.name.padEnd(24)} 8bs run ${system.target}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}\n`);
    for (const { key, need, have } of system.unmet ?? []) {
      process.stdout.write(`  ${' '.repeat(24)} short: ${key} needs ${need === true ? 'it' : need}, has ${have === true ? 'it' : have}\n`);
    }
  }
}

/** What the program asks of any machine, for the table form. */
function printRequires(requires) {
  const entries = Object.entries(requires);
  if (entries.length === 0) return;
  process.stdout.write('\nThis program needs, of any machine:\n');
  for (const [key, need] of entries) {
    process.stdout.write(`  ${key.padEnd(24)} ${need === true ? 'yes' : `at least ${need}`}\n`);
  }
}

/** @returns {Promise<number>} exit code */
export async function targets(args) {
  const config = await loadConfig(process.cwd(), '8bs targets');
  const required = projectRequires(config);
  const systems = projectSystems(config);
  const described = describeTargets(config);
  if (args.includes('--json')) {
    // A `systems` block the config gets wrong costs the reader its
    // systems and nothing else: the machines and their catalogs are the
    // toolchain's and are still true. The editor reads this, and a whole
    // hardware panel disappearing because of a typo three lines away
    // would say nothing about what is wrong.
    process.stdout.write(`${JSON.stringify({
      targets: described,
      systems: systems.ok ? systems.systems : [],
      systemsError: systems.ok ? null : systems.error,
      requires: required.ok ? required.requires : {},
      requiresError: required.ok ? null : required.error,
      facts: describeFacts(),
    }, null, 2)}\n`);
    return 0;
  }
  for (const result of [required, systems]) {
    if (!result.ok) {
      process.stderr.write(`8bs targets: ${result.error}\n`);
      return 1;
    }
  }
  for (const t of described) {
    const presets = Object.keys(t.presets);
    const profiles = Object.keys(t.profiles);
    process.stdout.write(`${t.id.padEnd(8)} ${t.title} — ${t.emulator}${t.region ? ', --pal available' : ''}${t.inRelease ? '' : '  (parked: not built in this release)'}\n`);
    for (const [optionId, option] of Object.entries(t.options)) {
      const values = Object.entries(option.values)
        .map(([value, entry]) => `${value}${value === option.default ? '*' : ''}${entry.affectsBuild ? ' (build)' : ''}`)
        .join(', ');
      process.stdout.write(`         --hardware ${optionId}=  ${option.label}: ${values}\n`);
      const probes = new Map();
      for (const [value, entry] of Object.entries(option.values)) {
        if (!entry.detect || value === option.default) continue;
        probes.set(entry.detect, [...(probes.get(entry.detect) ?? []), value]);
      }
      for (const [probe, found] of probes) {
        process.stdout.write(`                            ${found.join(', ')} found at run time by ${probe}\n`);
      }
    }
    if (presets.length > 0) process.stdout.write(`         --profile  presets: ${presets.join(', ')}\n`);
    if (profiles.length > 0) process.stdout.write(`         --profile  this project: ${profiles.join(', ')}\n`);
    const own = Object.entries(t.hardware).map(([k, v]) => `${k}=${v}`);
    if (own.length > 0) process.stdout.write(`         this project's default: ${own.join(' ')}\n`);
  }
  printRequires(required.requires);
  printSystems(systems.systems);
  process.stdout.write('\n* the default; (build) changes the program, not only the emulator\n');
  return 0;
}
