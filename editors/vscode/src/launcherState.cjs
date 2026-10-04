// What the launcher page is told, and the rules that decide it.
//
// This file is pure — no `vscode`, no file system — so every rule below is
// testable on its own, and the page (media/launcher.js) can be rendered from
// the same fixtures the tests use. The page holds no truth of its own: the
// extension builds one `LauncherState`, posts it, and the page draws it.
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

const WEB_NO_NATIVE = 'The Web system runs in a browser, so it has no native emulator.';

/**
 * What each runtime can do for one program on one system.
 *
 * @param {object} input
 * @param {{ id: string, emulator?: string|null }} input.system
 * @param {{ ok: boolean, reason?: string } | undefined} [input.wasm] whether the
 *   machine has a WASM build the program can use; undefined means yes
 * @param {boolean} [input.emulatorMissing] the native emulator is not installed
 * @param {boolean} [input.nativeFails] it is installed but cannot boot
 * @returns {Record<'editor'|'browser'|'native', { ok: boolean, reason?: string, use?: string, fixable?: boolean, emulator?: string }>}
 */
function availability({ system, wasm, emulatorMissing = false, nativeFails = false }) {
  const av = { editor: { ok: true }, browser: { ok: true }, native: { ok: true } };
  if (wasm && wasm.ok === false) {
    const reason = wasm.reason || `There is no WASM build of ${system.id} for this program yet.`;
    av.editor = { ok: false, reason, use: 'native' };
    av.browser = { ok: false, reason, use: 'native' };
  }
  if (!system.emulator) {
    av.native = { ok: false, reason: WEB_NO_NATIVE, use: 'editor' };
  } else if (emulatorMissing) {
    av.native = {
      ok: false, fixable: true, emulator: system.emulator,
      reason: `${system.emulator} isn't installed, so Native can't run.`, use: 'editor',
    };
  } else if (nativeFails) {
    av.native = {
      ok: false, fixable: true, emulator: system.emulator,
      reason: `${system.emulator} is installed but cannot boot.`, use: 'editor',
    };
  }
  return av;
}

/**
 * The runtime a primary button means. The remembered one when it still works;
 * otherwise the first that does. With nothing remembered the default is the
 * Editor tab (`preferEditor`) and Native after it — Browser is never a default,
 * because it opens a window outside the editor.
 *
 * @returns {{ runtime: string|null, moved?: string }}
 */
function primaryRuntime(av, remembered, { preferEditor = true } = {}) {
  const order = preferEditor ? ['editor', 'native', 'browser'] : ['native', 'editor', 'browser'];
  const label = (id) => RUNTIMES.find((r) => r.id === id).label;
  if (remembered && av[remembered]?.ok) return { runtime: remembered };
  const next = order.find((id) => av[id]?.ok) ?? null;
  if (remembered && next && av[remembered]) {
    return { runtime: next, moved: `${label(remembered)} is unavailable here, so ${label(next)} is the default.` };
  }
  return { runtime: next };
}

/** The inputs whose value differs from the default. */
const changedInputs = (inputs = []) => inputs.filter((i) => i.value !== i.def);

/** `NAME=value` for each changed input, as `--define` takes them. */
const defineFlags = (inputs = []) => changedInputs(inputs).map((i) => `${i.name}=${i.value}`);

/**
 * The `8bs` command a click runs, from the base argv (`run c64 --program p
 * ...`, as projects.commandArgs builds it), the runtime and the changed inputs.
 *
 * @param {string[]} base
 * @param {string} runtime
 * @param {string[]} [defines]
 * @returns {string}
 */
function commandLine(base, runtime, defines = []) {
  const args = [...base];
  const runtimeFlags = runtime === 'editor' ? ['--web', '--no-open', '--port', '0']
    : runtime === 'browser' ? ['--web'] : [];
  // Keep `--size` last, where the CLI prints it, and the defines after it so
  // an input is always the tail of the line.
  const at = args.indexOf('--size');
  if (at >= 0) args.splice(at, 0, ...runtimeFlags);
  else args.push(...runtimeFlags);
  for (const d of defines) args.push('--define', d);
  return ['8bs', ...args].join(' ');
}

const GROUP_ORDER = ['Projects', 'Examples', 'Apps'];

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

module.exports = {
  GROUP_ORDER, RUNTIMES, RUNTIME_IDS, WEB_NO_NATIVE,
  availability, changedInputs, commandLine, defineFlags, normalizeState, primaryRuntime,
};
