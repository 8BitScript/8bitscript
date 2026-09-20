// `8bs targets --reach` — which machines a program is for, joined with who
// is out there to run it (docs/project/reach.md).
//
// A reach figure is not a fact. It never folds, never changes a byte of a
// build, and is read by nothing on the build path: only this report and
// the editor's panel see it. The sheet is `data/reach.json`, one object
// per machine — units sold, 2026 community activity, routes to a user and
// the file formats each takes — every figure carrying `source` and `asOf`,
// `verify: true` where no fetched page confirmed it, and a range where the
// sources disagree. The CLI's data test holds every figure to that, the
// way the catalog test holds every machine to the fact table.
//
// Two rules keep research from printing as fact. Anything the catalog can
// answer for a machine that builds comes from the catalog — the stock sheet
// says whether there is a keyboard, a control port, a pad port, and the
// project's `requires` is checked against it the way a named system is —
// and the reach sheet only speaks for the machines with no package. And a
// sheet figure prints with its date, and a `verify`-flagged one with a
// marker, so a number the reader quotes is one they were told to check.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { MACHINES, RELEASE_MACHINES, unmetRequirements } from '@8bitscript/compiler';
import { outputExtension } from '@8bitscript/compiler/mos';

import { loadCatalog, resolveHardware, stockFacts } from './hardware.mjs';

/** The sheet's own path, beside `src/`: published with the package. */
export const REACH_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'reach.json');

/**
 * The input devices a program can say it is designed for — the portable
 * names, one per kind of thing a hand holds, matched against the
 * catalog's facts for a machine that builds and the sheet's
 * `input.standard` / `input.optional` for one that does not.
 */
export const INPUT_DEVICES = ['stick', 'pad', 'keyboard', 'mouse', 'paddles', 'touch'];

/** @type {{ refreshed: string, systems: Record<string, object> } | null} */
let cached = null;

/** The reach sheet, parsed once. */
export function loadReach(path = REACH_PATH) {
  if (path === REACH_PATH && cached) return cached;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (path === REACH_PATH) cached = data;
  return data;
}

/**
 * Every figure on the sheet with a number in it, as (path, object) pairs:
 * an object with a numeric `value`, `members`, `views`, `gamesTagged`,
 * `figure`, `low`, `high` or `cited` is a figure, and a figure must say
 * where it came from and when. Walks the whole sheet so a column added
 * later is held to the rule without a line changing here.
 *
 * @param {unknown} node
 * @param {string} path
 * @returns {{ path: string, figure: object }[]}
 */
function figures(node, path = '') {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((item, i) => figures(item, `${path}[${i}]`));
  const keys = ['value', 'members', 'views', 'gamesTagged', 'figure', 'low', 'high', 'cited'];
  const own = keys.some((key) => typeof node[key] === 'number') ? [{ path, figure: node }] : [];
  return [
    ...own,
    ...Object.entries(node).flatMap(([key, child]) => figures(child, path ? `${path}.${key}` : key)),
  ];
}

/**
 * Where a figure says when and where it was read. A figure carries its own
 * `source`/`asOf`, or sits in a block that carries them for it (a units
 * block's `sources[]` each dated; an indicator's `members2023Source` and
 * `members2023CheckedOn` beside `members2023`).
 */
function isSourced(figure) {
  const dated = ['asOf', 'checkedOn', 'members2023CheckedOn', 'membersMethod', 'period'].some((k) => typeof figure[k] === 'string' && figure[k].length > 0)
    || (Array.isArray(figure.sources) && figure.sources.length > 0);
  const placed = ['source', 'sources', 'membersSource', 'members2023Source', 'url'].some((k) => figure[k] !== undefined && figure[k] !== null && figure[k] !== '')
    || figure.verify === true;
  return dated && placed;
}

/**
 * What is wrong with a reach sheet, in words — empty for the one that
 * ships. Every machine that builds (but the web, which is a URL, not a
 * fleet) has a row; every row has a `status`; every figure is sourced and
 * dated or flagged `verify`.
 *
 * @param {object} data
 * @returns {string[]}
 */
export function reachProblems(data) {
  const problems = [];
  if (!data || typeof data !== 'object' || typeof data.refreshed !== 'string') problems.push('the sheet has no `refreshed` date');
  const systems = data?.systems ?? {};
  for (const id of RELEASE_MACHINES) {
    if (id !== 'web' && !systems[id]) problems.push(`${id} builds and has no row`);
  }
  for (const [id, system] of Object.entries(systems)) {
    if (!['builds', 'roadmap', 'unplanned'].includes(system.status)) problems.push(`${id}: status must be builds, roadmap or unplanned`);
    if (system.status === 'builds' && !MACHINES.includes(id)) problems.push(`${id}: says it builds, and no such machine`);
    if (system.status === 'roadmap' && !Number.isInteger(system.phase)) problems.push(`${id}: on the roadmap and no phase`);
    if (typeof system.name !== 'string') problems.push(`${id}: no name`);
    for (const { path, figure } of figures(system)) {
      if (!isSourced(figure)) problems.push(`${id}: ${path} has a figure and no source or date`);
    }
  }
  return problems;
}

/**
 * `input` in 8bitscript.config.ts: what the program is designed to be
 * played with, and what else it plays on.
 *
 *     input: { primary: 'stick', also: ['keyboard', 'pad'] }
 *
 * Not a floor — `requires` is the floor, and `input.keyboard: true`
 * there still refuses a machine without one. This is a preference the
 * reach report reads: for each machine, whether the primary device is
 * standard, optional, or absent, and the same for each `also`.
 *
 * @param {object|null} config
 * @returns {{ ok: true, input: null | { primary: string, also: string[] } } | { ok: false, error: string }}
 */
export function projectInput(config) {
  const declared = config?.input;
  if (declared === undefined || declared === null) return { ok: true, input: null };
  const where = "8bitscript.config.ts's `input`";
  if (typeof declared !== 'object' || Array.isArray(declared)) {
    return { ok: false, error: `${where} must be { primary, also? }` };
  }
  const { primary, also = [], ...rest } = declared;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) return { ok: false, error: `${where} has no key ${unknown.map((k) => `\`${k}\``).join(', ')} — only primary and also` };
  if (!INPUT_DEVICES.includes(primary)) {
    return { ok: false, error: `${where}.primary must be one of ${INPUT_DEVICES.join(', ')}, not ${JSON.stringify(primary)}` };
  }
  if (!Array.isArray(also) || also.some((d) => !INPUT_DEVICES.includes(d))) {
    return { ok: false, error: `${where}.also must list devices from ${INPUT_DEVICES.join(', ')}` };
  }
  if (also.includes(primary)) return { ok: false, error: `${where}.also repeats the primary device ${JSON.stringify(primary)}` };
  return { ok: true, input: { primary, also: [...new Set(also)] } };
}

/**
 * Whether a machine that builds has a device, from its stock sheet. A
 * control port or a pad port is the device it is for: the catalog counts
 * ports, and a port's standard controller is what every owner has. A
 * mouse or paddles are `when: 'run'` facts — the build may use them, an
 * owner may not have them — so they are never more than optional. Touch
 * is the web's alone and the web is not on the sheet.
 *
 * @param {string} device
 * @param {object} facts
 * @returns {'standard'|'optional'|'absent'}
 */
export function standingFromFacts(device, facts) {
  switch (device) {
    case 'stick': return facts['input.joysticks'] > 0 ? 'standard' : 'absent';
    case 'pad': return facts['input.pads'] > 0 ? 'standard' : 'absent';
    case 'keyboard': return facts['input.keyboard'] === true ? 'standard' : 'absent';
    case 'mouse': return facts['input.mouse'] === true ? 'optional' : 'absent';
    case 'paddles': return facts['input.paddles'] === true ? 'optional' : 'absent';
    default: return 'absent';
  }
}

/** The words a sheet uses for each device in `input.standard` / `input.optional`. */
const SHEET_WORDS = {
  stick: /joystick|stick\b/i,
  pad: /gamepad|\bpad\b|controller/i,
  keyboard: /keyboard/i,
  mouse: /mouse/i,
  paddles: /paddle/i,
  touch: /touch/i,
};

/**
 * Whether a machine with no package has a device, from its sheet — the
 * research answer, for a machine the catalog cannot speak for.
 *
 * @param {string} device
 * @param {{ standard?: string[], optional?: string[] }} input
 * @returns {'standard'|'optional'|'absent'}
 */
export function standingFromSheet(device, input) {
  const word = SHEET_WORDS[device];
  const has = (list) => (list ?? []).some((entry) => word.test(entry));
  if (has(input?.standard)) return 'standard';
  if (has(input?.optional)) return 'optional';
  return 'absent';
}

/**
 * How a build gets to a user of this machine. Every program the toolchain
 * builds today is one resident file (docs/project/reach.md, "Delivery
 * shape"), written as `writes` — `.prg`, `.xex`, `.nes` — for a machine
 * with a package, and nothing yet for one without. Each of the sheet's
 * routes (an SD bridge on the original hardware, an emulator, an FPGA
 * core, a mini-console, a browser) lists the formats it takes; the file
 * the toolchain writes either is one of them or is not, and a route it
 * is not says what it wants instead — a `.d64` the `images` writer will
 * make, a `.crt` no media value makes yet.
 *
 * @param {object} system  the sheet's row
 * @param {string|null} writes  the extension the toolchain writes, no dot
 */
export function delivery(system, writes) {
  const routes = (system.routes ?? []).map((route) => ({ route: route.route, formats: route.formats ?? [] }));
  const takes = (route) => writes !== null && route.formats.some((f) => f.toLowerCase() === writes);
  return {
    shape: 'single',
    writes,
    reaches: routes.filter(takes).map((r) => r.route),
    // A route that lists no format says nothing about the file and is left out.
    wants: routes.filter((r) => !takes(r) && r.formats.length > 0).map((r) => ({ route: r.route, formats: r.formats })),
  };
}

/** The extension `8bs build` writes for a machine's stock hardware, no dot; null for one that has no package. */
function writtenExtension(id) {
  if (!MACHINES.includes(id)) return null;
  const { hardware } = resolveHardware(loadCatalog(id), {});
  return outputExtension(id, hardware).replace(/^\./, '');
}

/** A number the reader can quote: `12.5M`, `452K`, `1,745`. */
export function compact(n) {
  if (n == null) return null;
  if (n >= 1e6) return `${Math.round(n / 1e4) / 100}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  return n.toLocaleString('en-US');
}

/**
 * Every machine on the sheet, joined with what this project asks: one
 * row per machine, in the sheet's order. For a machine that builds, the
 * floor standing is the catalog's answer (`requires` against the stock
 * sheet); for one that does not, the row says so and the phase. Input
 * standings come from the catalog where there is one and from the sheet
 * where there is not, and say which.
 *
 * @param {object} options
 * @param {object} options.requires  the project's, already checked
 * @param {null | { primary: string, also: string[] }} options.input
 * @param {object} [options.data]     the sheet; the package's own by default
 */
export function describeReach({ requires = {}, input = null, data = loadReach() }) {
  return Object.entries(data.systems).map(([id, system]) => {
    const builds = system.status === 'builds';
    const facts = builds ? stockFacts(id) : null;
    const standing = (device) => (builds
      ? { device, standing: standingFromFacts(device, facts), from: 'catalog' }
      : { device, standing: standingFromSheet(device, system.input), from: 'sheet' });
    const units = system.unitsSold ?? {};
    const ind = system.indicators ?? {};
    const yearly = (system.activity?.homebrewDb ?? [])
      .filter((h) => /\b2025\b/.test(h.metric) && !/YTD|to date/i.test(h.metric))
      .map((h) => ({ database: h.name, entries: h.value, source: h.source, asOf: h.asOf }));
    return {
      id,
      name: system.name,
      status: system.status,
      phase: system.phase ?? null,
      // What the project asks, against what the machine has.
      floor: builds ? unmetRequirements(requires, facts) : null,
      input: input ? { primary: standing(input.primary), also: input.also.map(standing) } : null,
      delivery: delivery(system, builds ? writtenExtension(id) : null),
      reach: {
        refreshed: data.refreshed,
        units: {
          low: units.low ?? null, high: units.high ?? null, cited: units.cited ?? null, contested: units.contested === true,
        },
        pageviews2025: ind.pageviews2025?.views ?? null,
        pageviewsProxy: ind.pageviews2025?.proxy === true || /proxy/i.test(ind.pageviews2025?.note ?? ''),
        itchio: ind.itchio?.gamesTagged ?? null,
        subreddit2023: ind.subreddit?.members2023 ?? null,
        homebrew2025: yearly,
        newHardware: (ind.reissues ?? [])
          .filter((r) => /ship|stock|in production|listed|available|order/i.test(r.status ?? ''))
          .map((r) => r.name),
        verify: (system.activity?.subreddit?.verify === true) || units.verify === true,
      },
    };
  });
}

/** One machine's rows, for the table form. */
export function formatReach(row) {
  const lines = [];
  const head = row.status === 'builds'
    ? (row.floor.length === 0
      ? 'builds'
      : `refused: ${row.floor.map(({ key, need, have }) => `${key} needs ${need === true ? 'it' : need}, has ${have === true ? 'it' : have}`).join('; ')}`)
    : (row.status === 'roadmap' ? `no package — phase ${row.phase} (docs/project/machines/)` : 'no package — not on the roadmap');
  lines.push(`${row.id.padEnd(11)} ${head}`);
  if (row.input) {
    const say = ({ device, standing, from }) => `${device}: ${standing}${from === 'sheet' ? ' (sheet)' : ''}`;
    lines.push(`${''.padEnd(11)} input    ${[say(row.input.primary), ...row.input.also.map(say)].join(' · ')}`);
  }
  const d = row.delivery;
  if (d.writes) {
    const wants = d.wants.map((w) => `${w.route} wants ${w.formats.join('/')}`);
    lines.push(`${''.padEnd(11)} single   .${d.writes} reaches ${d.reaches.join(', ') || 'no route'}${wants.length > 0 ? `; ${wants.join('; ')}` : ''}`);
  } else {
    lines.push(`${''.padEnd(11)} single   nothing written yet; routes take ${[...new Set(d.wants.flatMap((w) => w.formats))].join(', ')}`);
  }
  const r = row.reach;
  const units = r.units.low == null && r.units.high == null
    ? 'no units figure'
    : `${r.units.low != null && r.units.high != null && r.units.low !== r.units.high ? `${compact(r.units.low)}–${compact(r.units.high)}` : compact(r.units.low ?? r.units.high)} sold${r.units.contested ? ' †' : ''}`;
  const parts = [
    units,
    r.pageviews2025 != null && `${compact(r.pageviews2025)} views/yr${r.pageviewsProxy ? ' ‡' : ''}`,
    r.homebrew2025.length > 0 && r.homebrew2025.map((h) => `${compact(h.entries)} ${h.database} entries/yr`).join(', '),
    r.itchio != null && `${compact(r.itchio)} on itch.io`,
    r.subreddit2023 != null && `${compact(r.subreddit2023)} on reddit (2023)`,
    r.newHardware.length > 0 && `new hardware: ${r.newHardware.join('; ')}`,
  ].filter(Boolean);
  lines.push(`${''.padEnd(11)} reach    ${parts.join(' · ')}`);
  return lines;
}

/** The whole report, with the legend the markers need. */
export function printReach(rows, { refreshed }) {
  for (const row of rows) process.stdout.write(`${formatReach(row).join('\n')}\n`);
  process.stdout.write(`\nreach sheet refreshed ${refreshed} (packages/cli/data/reach.json; every figure has a source and a date there)\n`
    + '† sources disagree — a range, read sources[] before quoting one   ‡ no article of its own; a proxy\n'
    + '(sheet) research, not the catalog: the machine has no package yet\n');
}
