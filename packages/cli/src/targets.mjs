// `8bs targets [--json]` — every machine the toolchain builds for, and the
// hardware each can be fitted with: the catalog every machine package
// declares (packages/cli/src/hardware.mjs), plus the profiles the project
// in the current directory composes in its 8bs.config.ts. The editor reads
// the JSON form to build its System, Profile and Hardware controls, so a
// new machine or option in a package is a new row there with nothing to
// update by hand.
import { MACHINES } from '@8bitscript/compiler';

import { loadConfig } from './config.mjs';
import { loadCatalog, projectProfiles } from './hardware.mjs';
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
      values: Object.fromEntries(Object.entries(option.values).map(([value, entry]) => [value, {
        label: entry.label,
        affectsBuild: Boolean(entry.build),
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
    };
  });
}

/** @returns {Promise<number>} exit code */
export async function targets(args) {
  const config = await loadConfig(process.cwd(), '8bs targets');
  const described = describeTargets(config);
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ targets: described }, null, 2)}\n`);
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
    }
    if (presets.length > 0) process.stdout.write(`         --profile  presets: ${presets.join(', ')}\n`);
    if (profiles.length > 0) process.stdout.write(`         --profile  this project: ${profiles.join(', ')}\n`);
  }
  process.stdout.write('\n* the default; (build) changes the program, not only the emulator\n');
  return 0;
}
