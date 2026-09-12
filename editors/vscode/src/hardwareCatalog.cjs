// What `8bs targets --json` says, as the launcher needs it.
//
// The CLI is the only place the machines' hardware catalogs live (each
// machine package's "8bitscript".hardware), so the editor never lists an
// option, a value, or a preset of its own: it asks the toolchain and shows
// the answer. This module is deliberately free of the `vscode` API so it
// can be tested with plain `node --test`; runner.cjs spawns the command
// and hands the text here.

/**
 * Parse the JSON `8bs targets --json` prints.
 *
 * @param {string} text
 * @returns {Map<string, object>} target id → its description, in the CLI's order
 */
function parseTargets(text) {
  const parsed = JSON.parse(text);
  const targets = new Map();
  for (const target of parsed.targets ?? []) targets.set(target.id, target);
  // The fact schema rides along on the map: the panel's sheet labels
  // itself from it, and there is one for every target.
  targets.facts = Array.isArray(parsed.facts) ? parsed.facts : [];
  // So do the whole machines the project has been set up for — its
  // `systems` block, already resolved and validated by the CLI. They are
  // the project's, not a machine's, so they hang off the map rather than
  // off an entry.
  targets.systems = Array.isArray(parsed.systems) ? parsed.systems : [];
  // A `systems` block the config gets wrong costs the panel its systems
  // and nothing else — the CLI still answers about the machines. The
  // message is shown where a warning goes, so a typo is findable.
  targets.systemsError = typeof parsed.systemsError === 'string' ? parsed.systemsError : null;
  // And what the program asks of any machine it is built for — its
  // `requires` block. Each system carries what it falls short of, worked
  // out by the CLI against the same sheet the build will resolve to.
  targets.requires = parsed.requires && typeof parsed.requires === 'object' ? parsed.requires : {};
  targets.requiresError = typeof parsed.requiresError === 'string' ? parsed.requiresError : null;
  return targets;
}

/**
 * Whether a selection is exactly what one of the project's systems fits:
 * the same machine, the same region, and every option landing on the same
 * value. Compared by what the options resolve to rather than by
 * remembering which entry was picked, so the panel still holds no state —
 * reaching the same machine by hand names it just the same.
 *
 * @param {object} system one entry of targets.systems
 * @param {object|undefined} target the catalog entry for system.target
 * @param {{ profile: string|null, options: Record<string, string> }} selection
 * @param {'ntsc'|'pal'} region
 */
function matchesSystem(system, target, selection, region) {
  if (system.region !== null && system.region !== region) return false;
  if (!target) return false;
  const theirs = effectiveOptions(target, { profile: system.profile, options: system.hardware });
  const ours = effectiveOptions(target, selection);
  return Object.keys(theirs).every((id) => theirs[id] === ours[id]);
}

/**
 * A person's selection for one system, as the setting stores it:
 * `{ profile, options }`, either part optional. Anything malformed is the
 * stock machine.
 *
 * @param {unknown} stored
 * @returns {{ profile: string|null, options: Record<string, string> }}
 */
function normalizeSelection(stored) {
  const profile = typeof stored?.profile === 'string' && stored.profile !== '' ? stored.profile : null;
  const options = {};
  if (stored?.options && typeof stored.options === 'object') {
    for (const [key, value] of Object.entries(stored.options)) {
      if (typeof value === 'string' && value !== '') options[key] = value;
    }
  }
  return { profile, options };
}

/**
 * The `--profile`/`--hardware` arguments a selection adds to a command
 * line. Options are written `--hardware a=b,c=d`, one flag, in option order.
 *
 * @param {{ profile: string|null, options: Record<string, string> }} selection
 * @returns {string[]}
 */
function hardwareArgs(selection) {
  const { profile, options } = normalizeSelection(selection);
  const args = [];
  if (profile) args.push('--profile', profile);
  const pairs = Object.entries(options).map(([key, value]) => `${key}=${value}`);
  if (pairs.length > 0) args.push('--hardware', pairs.join(','));
  return args;
}

/**
 * The value each option ends up with for a selection on a target: the
 * catalog default, then the profile's values (a project profile shadows a
 * preset, as the CLI's rule is), then the options set on top — the same
 * order the CLI resolves in, so what the panel shows is what runs.
 *
 * @param {object} target one entry of parseTargets()
 * @param {{ profile: string|null, options: Record<string, string> }} selection
 * @returns {Record<string, string>}
 */
function effectiveOptions(target, selection) {
  const { profile, options } = normalizeSelection(selection);
  const result = {};
  for (const [id, option] of Object.entries(target.options ?? {})) result[id] = option.default;
  // The project's own default hardware for this machine (8bitscript.config.ts,
  // `targets.<machine>.hardware`) is its stock.
  for (const [id, value] of Object.entries(target.hardware ?? {})) if (id in result) result[id] = String(value);
  const named = profile ? (target.profiles?.[profile] ?? target.presets?.[profile] ?? {}) : {};
  for (const [id, value] of Object.entries(named)) if (id in result) result[id] = String(value);
  for (const [id, value] of Object.entries(options)) if (id in result) result[id] = value;
  return result;
}

/**
 * The fact sheet a selection gives a program on a target: the stock
 * machine's facts, changed by each chosen value's facts in option order —
 * the merge the CLI's resolveHardware does, so the panel's sheet is what
 * `Video.COLUMNS` and the rest fold to in that build.
 *
 * @param {object} target one entry of parseTargets()
 * @param {{ profile: string|null, options: Record<string, string> }} selection
 * @returns {Record<string, number|boolean>}
 */
function effectiveFacts(target, selection) {
  const facts = { ...(target.facts ?? {}) };
  const effective = effectiveOptions(target, selection);
  for (const [id, option] of Object.entries(target.options ?? {})) {
    Object.assign(facts, option.values?.[effective[id]]?.facts ?? {});
  }
  return facts;
}

/**
 * A one-line spelling of what a selection fits, for a row's description:
 * the profile's name and any option set on top, or nothing for stock.
 */
function selectionLabel(selection) {
  const { profile, options } = normalizeSelection(selection);
  const parts = [];
  if (profile) parts.push(profile);
  for (const [key, value] of Object.entries(options)) parts.push(`${key}=${value}`);
  return parts.join(' ');
}

/**
 * What picking `presetId` sets beyond its own name: every option whose
 * resolved value differs from that option's own catalog default, as
 * `id=value` pairs — the same shape `selectionLabel` already uses for a
 * *chosen* selection, computed here for a preset still sitting in a
 * dropdown list, before it is chosen. A preset named after one of its own
 * option's values (the PET's `3016` naming `model: '3016'`) would
 * otherwise read as if it only touched that one option — this is what
 * makes `--profile 3016` setting `ram: '16'` too, not just `model`,
 * visible in the preset's own label, not just after picking it and
 * checking every other dropdown by hand.
 *
 * @param {object} target one entry of parseTargets()
 * @param {string} presetId a key of target.presets or target.profiles
 * @returns {string}
 */
function presetBundle(target, presetId) {
  const resolved = effectiveOptions(target, { profile: presetId, options: {} });
  return Object.entries(resolved)
    .filter(([id, value]) => value !== target.options?.[id]?.default && value !== presetId)
    .map(([id, value]) => `${id}=${value}`)
    .join(' ');
}

/**
 * The machine's worst case rather than its stock config: for every option
 * where at least one value declares `memory.ram`, the value with the
 * least of it; every other option (a control port, a drive) is left at
 * its catalog default. This is what a first run with nothing chosen
 * should fit a program against — the smallest RAM the machine is meant to
 * run on, not whichever value the catalog happens to name `default` (the
 * PET's is the roomiest model, 3032's 32K, because that is the sensible
 * *label* for "no --profile given" — not the sensible machine to test a
 * program's RAM budget against).
 *
 * A machine with no RAM-varying option (the web, a C64 with only a
 * control-port and REU-presence choice) resolves to `{}` here — the same
 * stock config `normalizeSelection(undefined)` already means — so this is
 * a no-op everywhere it has nothing useful to pick.
 *
 * @param {object} target one entry of parseTargets()
 * @returns {{ profile: string|null, options: Record<string, string> }}
 */
function worstSelection(target) {
  const options = {};
  for (const [id, option] of Object.entries(target.options ?? {})) {
    let worst = null;
    let worstRam = Infinity;
    for (const [value, entry] of Object.entries(option.values ?? {})) {
      const ram = entry.facts?.['memory.ram'];
      if (typeof ram === 'number' && ram < worstRam) {
        worst = value;
        worstRam = ram;
      }
    }
    if (worst !== null && worst !== option.default) options[id] = worst;
  }
  return { profile: null, options };
}

module.exports = {
  matchesSystem,
  effectiveFacts,
  effectiveOptions,
  hardwareArgs,
  normalizeSelection,
  parseTargets,
  presetBundle,
  selectionLabel,
  worstSelection,
};
