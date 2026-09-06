// `8bs targets [--json]` — every machine the toolchain builds for, and the
// hardware each can be fitted with: the catalog every machine package
// declares (packages/cli/src/hardware.mjs), plus the profiles the project
// in the current directory composes in its 8bs.config.ts. The editor reads
// the JSON form to build its System, Profile and Hardware controls, so a
// new machine or option in a package is a new row there with nothing to
// update by hand.
import { FACTS, MACHINES } from '@8bitscript/compiler';

import { loadConfig } from './config.mjs';
import { loadCatalog, projectHardware, projectProfiles, stockFacts } from './hardware.mjs';
import { VICE_EMULATOR } from './run.mjs';

const EMULATOR = {
  ...VICE_EMULATOR, atari8: 'atari800', nes: 'fceux', cx16: 'x16emu', mega65: 'xmega65', web: 'the browser',
};
// The targets whose emulator takes a region; the same set build.mjs names.
const REGION = new Set(['vic20', 'c64', 'c128', 'mega65', 'atari8']);

const TITLE = {
  vic20: 'Commodore VIC-20', c64: 'Commodore 64', pet: 'Commodore PET', c128: 'Commodore 128',
  atari8: 'Atari 8-bit', nes: 'Nintendo Entertainment System', cx16: 'Commander X16', mega65: 'MEGA65', web: 'Web',
};

/**
 * One entry per target: what the editor's dropdowns and hardware panel
 * are built from.
 *
 * @param {object|null} config the project's 8bs.config.ts, if any
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
      emulator: EMULATOR[id],
      region: REGION.has(id),
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

/** @returns {Promise<number>} exit code */
export async function targets(args) {
  const config = await loadConfig(process.cwd(), '8bs targets');
  const described = describeTargets(config);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ targets: described, facts: describeFacts() }, null, 2)}\n`);
    return 0;
  }
  for (const t of described) {
    const presets = Object.keys(t.presets);
    const profiles = Object.keys(t.profiles);
    process.stdout.write(`${t.id.padEnd(8)} ${t.title} — ${t.emulator}${t.region ? ', --pal available' : ''}\n`);
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
  process.stdout.write('\n* the default; (build) changes the program, not only the emulator\n');
  return 0;
}
