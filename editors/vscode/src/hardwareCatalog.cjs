// What `8bs targets --json` says, as the controls view needs it.
//
// The CLI is the only place the machines' hardware catalogs live (each
// machine package's "8bitscript".hardware), so the editor never lists an
// option, a value, or a preset of its own: it asks the toolchain and shows
// the answer. This module is deliberately free of the `vscode` API so it
// can be tested with plain `node --test`; the view (controlsView.cjs)
// spawns the command and hands the text here.

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
  return targets;
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
  const named = profile ? (target.profiles?.[profile] ?? target.presets?.[profile] ?? {}) : {};
  for (const [id, value] of Object.entries(named)) if (id in result) result[id] = String(value);
  for (const [id, value] of Object.entries(options)) if (id in result) result[id] = value;
  return result;
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

module.exports = {
  effectiveOptions,
  hardwareArgs,
  normalizeSelection,
  parseTargets,
  selectionLabel,
};
