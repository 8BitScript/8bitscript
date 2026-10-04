// What the launcher page is told, and how.
//
// This file is pure — no `vscode`, no file system — so it is testable on its
// own, and the page (media/launcher.js) can be rendered from the same
// fixtures the tests use. The page holds no truth of its own: the extension
// builds one `LauncherState`, posts it, and the page draws it.
//
// The *rules* — which runtimes a program can use on a machine, which one is
// the default, which inputs a program has and the `--define` flags they become
// — are the unit model's (units.cjs), not this file's; this file only says how
// the page is told what the model decided.
//
// ── The vocabulary ──────────────────────────────────────────────────────────
//   Project  a folder with an 8bitscript.config.8bs
//   Program  a work unit — one entry of the config's `programs`
//   System   a machine plus its hardware, region and language
//   Runtime  where a program runs: `editor` (the WASM build in an editor
//            tab), `browser` (the WASM build in the system browser), or
//            `native` (the machine's real emulator)
//
// ── LauncherState (extension → page, message type "state") ──────────────────
// {
//   version: 1,
//   phase: 'loading' | 'ready' | 'empty',
//   runtimes: [{ id, label, icon, long, what }]      // always the three, in order
//   notices: [{ id, kind: 'info'|'warn'|'error', icon, title?, text,
//               actions: [{ label, icon?, msg }] }]  // msg is a PageMessage
//   projects: [{ id, label, where, group }]          // group: 'Projects'|'Examples'|'Apps'
//   project: { id, name, sub } | null
//   systems: [{ id, short, name, spec, region, group, emulator, enabled, reason? }]
//   system: <a systems[].id>
//   summary: { name, text }                          // 'Commodore 64' · '64 KB · NTSC · English'
//   programs: [{ id, title, group, description, entry, onSystem,
//                inputs: [{ name, label, kind: 'number'|'bool'|'text'|'select',
//                           def, value, help, options? }],
//                runtimes: { editor|browser|native: { ok, reason?, use?,
//                            fixable?, emulator? } },
//                primary: Runtime | null,            // last used, or the default
//                primaryMoved?: string,              // why the remembered runtime changed
//                live: Runtime[] }]                  // runtimes with a run in progress
//   program: <programs[].id> | null                  // the selected program
//   collapsedGroups: string[]                        // groups shown folded at first
//   command: string                                  // exact argv of the selected program's primary
//   running: [{ id, programId, title, system, runtime, elapsed, fps?, detail,
//               url?, lanUrl?, qrSvg?, command, details?, size?, facts?, error? }]
//   history: [{ id, title, system, runtime, result, when, ok }]
// }
//
// ── PageMessage (page → extension) ──────────────────────────────────────────
//   { type: 'run',      runtime, program, system, inputs }   inputs: changed only
//   { type: 'build',    program, system }
//   { type: 'boot',     system }                              open a bare emulator
//   { type: 'select',   program? | system? | project? }
//   { type: 'selectRuntime', program, runtime }               change the remembered one
//   { type: 'input',    program, name, value }
//   { type: 'inputsReset', program }
//   { type: 'openSource', program }
//   { type: 'reveal',   program }
//   { type: 'copy',     text }
//   { type: 'stop',     runId }
//   { type: 'focus',    runId }                               show the Editor tab
//   { type: 'openInBrowser', runId }
//   { type: 'rerun',    historyId }
//   { type: 'fix',      kind: 'emulator'|'packages' }
//   { type: 'doctor' | 'details' | 'configureSystem' | 'saveSystem' | 'studio'
//         | 'openFolder' | 'tryExample' | 'learn' | 'rebuildExtension'
//         | 'reloadWindow' | 'ready' }
'use strict';

/** The three places a program can run, in the order they are always shown. */
const RUNTIMES = Object.freeze([
  { id: 'editor', label: 'Editor', icon: 'open-preview', long: 'Editor tab', what: 'Runs the WASM build in a tab inside the editor.' },
  { id: 'browser', label: 'Browser', icon: 'globe', long: 'Web browser', what: 'Runs the WASM build in your web browser.' },
  { id: 'native', label: 'Native', icon: 'device-desktop', long: 'Native emulator', what: 'Runs the real emulator for this machine.' },
].map(Object.freeze));

const RUNTIME_IDS = RUNTIMES.map((r) => r.id);

/**
 * A reason as a sentence: the model's are lower-case fragments without a stop.
 * A reason that begins with a program's name (`x64sc is not installed`) keeps it
 * as written.
 */
function sentence(text, { keep = null } = {}) {
  const t = String(text ?? '').trim();
  if (t === '') return '';
  const head = keep && t.startsWith(keep) ? t[0] : t[0].toUpperCase();
  return `${head}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`;
}

/**
 * The page's view of the unit model's runtime matrix: for each runtime whether
 * it works, why not, whether the reason can be fixed (an emulator to install,
 * Doctor to run), and the runtime to switch to instead.
 *
 * @param {Record<string, { available: boolean, reason: string|null, fix: string|null }>} matrix
 *   `units.runtimeMatrix(...)`
 * @param {{ emulator?: string|null }} [options] the native emulator's name, for the install button
 */
function availabilityFromMatrix(matrix, { emulator = null } = {}) {
  const out = {};
  for (const id of RUNTIME_IDS) {
    const cell = matrix[id] ?? { available: false, reason: null, fix: null };
    out[id] = cell.available ? { ok: true } : {
      ok: false,
      reason: sentence(cell.reason, { keep: emulator }),
      ...(cell.fix ? { fixable: true, emulator: emulator ?? undefined } : {}),
    };
  }
  for (const id of RUNTIME_IDS) {
    if (out[id].ok) continue;
    const alternative = ['editor', 'native', 'browser'].find((other) => other !== id && out[other].ok);
    if (alternative) out[id].use = alternative;
  }
  return out;
}

/** Said when the runtime a program last used no longer works and another is the default now. */
function movedNote(remembered, got, availability) {
  if (!remembered || !got || remembered === got || availability[remembered]?.ok !== false) return '';
  const label = (id) => RUNTIMES.find((r) => r.id === id).label;
  return `${label(remembered)} is unavailable here, so ${label(got)} is the default.`;
}

/**
 * One input of the unit model as the page's form draws it. The kind follows the
 * model's (`int` is a number, `string` is text); its *value* is what a plain run
 * uses, so "changed" means "differs from a plain run".
 *
 * @param {{ name: string, kind: string, default: unknown, value: unknown, description: string|null }} input
 * @param {Record<string, unknown>} [overrides] what the person has typed
 */
function inputRow(input, overrides = {}) {
  const base = input.value ?? input.default;
  return {
    name: input.name,
    label: input.name.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    kind: input.kind === 'bool' ? 'bool' : input.kind === 'string' ? 'text' : 'number',
    def: base,
    value: Object.prototype.hasOwnProperty.call(overrides, input.name) ? overrides[input.name] : base,
    help: input.description ?? '',
    options: [],
  };
}

/** Make a posted state safe to draw: every list is a list, every string a string. */
function normalizeState(raw = {}) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v, d = '') => (typeof v === 'string' ? v : d);
  const programs = arr(raw.programs).map((p) => ({
    id: str(p.id),
    title: str(p.title, str(p.id)),
    group: str(p.group),
    description: str(p.description),
    entry: str(p.entry),
    onSystem: p.onSystem !== false,
    inputs: arr(p.inputs).map((i) => ({
      name: str(i.name), label: str(i.label, str(i.name)), kind: ['number', 'bool', 'text', 'select'].includes(i.kind) ? i.kind : 'text',
      def: i.def, value: i.value === undefined ? i.def : i.value, help: str(i.help), options: arr(i.options),
    })),
    runtimes: Object.fromEntries(RUNTIME_IDS.map((id) => [id, { ok: false, ...(p.runtimes?.[id] ?? {}) }])),
    primary: RUNTIME_IDS.includes(p.primary) ? p.primary : null,
    primaryMoved: str(p.primaryMoved),
    live: arr(p.live).filter((r) => RUNTIME_IDS.includes(r)),
  }));
  const phase = ['loading', 'ready', 'empty'].includes(raw.phase) ? raw.phase : 'ready';
  return {
    version: 1,
    phase,
    runtimes: RUNTIMES,
    notices: arr(raw.notices),
    projects: arr(raw.projects),
    project: raw.project ?? null,
    systems: arr(raw.systems),
    system: str(raw.system),
    summary: raw.summary ?? null,
    programs,
    program: programs.some((p) => p.id === raw.program) ? raw.program : (programs[0]?.id ?? null),
    collapsedGroups: arr(raw.collapsedGroups),
    command: str(raw.command),
    running: arr(raw.running),
    history: arr(raw.history),
  };
}

module.exports = { RUNTIMES, RUNTIME_IDS, availabilityFromMatrix, inputRow, movedNote, normalizeState, sentence };
