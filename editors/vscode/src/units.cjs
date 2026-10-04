// The extension's model of "run this program, on this system, this way".
//
// Everything the launcher shows and every run command acts on goes through
// this module, and it knows nothing about the `vscode` API — it is plain
// data in, plain data out — so `node --test` exercises all of it. runner.cjs
// spawns the CLI and persists state; this file decides what the answers mean.
//
// ---- the words (docs/project/units.md) ------------------------------------
//
//   Project   a directory with an 8bitscript.config.8bs
//   Program   one thing the project builds, from its own `.8bs` entry (a
//             work unit; config `programs`)
//   System    a machine plus the hardware fitted to it (target, profile,
//             hardware options, region)
//   Runtime   how it runs:  'editor'  — the wasm page in an editor tab
//                           'browser' — the wasm page in the system browser
//                           'native'  — the machine's own emulator
//   Input     one `define` a program reads (a seed, a flag, a starting amount)
//
// ---- the API (stable: the launcher view is written against it) -------------
//
//   RUNTIMES                 ['editor', 'browser', 'native']
//   RUNTIME_LABELS           { editor: 'Editor', browser: 'Browser', native: 'Native' }
//
//   normalizeProject(raw)    the JSON `8bs project --json` prints  -> UnitProject
//   legacyProject(project)   what the regex config reader found    -> UnitProject
//                            (for a CLI older than `project --json`; `legacy: true`)
//   UnitProject = {
//     source: 'cli' | 'legacy', legacy: boolean, version: number,
//     dir, name, configPath, hasConfig, configError: string|null,
//     targets: string[],                // machines the project builds for
//     targetRows: { id, hardware, profiles, locale }[],
//     locales: { default, fallback, available: string[] } | null,
//     systems: { name, layer, target, profile, hardware, region }[],
//     problems: { scope: string, message: string }[],
//     programs: UnitProgram[],
//     main: string | null,              // the program a plain Run means
//     several: boolean,                 // more than one program: `--program` is needed
//   }
//   UnitProgram = {
//     name, label,                      // label = title ?? name
//     title|null, description|null, group|null,
//     entry (absolute), entryRelative, entryExists,
//     targets: string[],                // already narrowed to the project's machines
//     requires: object,
//     definesRead: boolean,             // false: the inputs may be incomplete
//     defines: Input[],
//     problems: string[],
//   }
//   Input = { name, kind: 'int'|'bool'|'string', default, value, description|null,
//             source: 'source'|'config-only' }
//
//   normalizeRuntime(row)    one machine's `runtime` object from `8bs targets --json`
//   legacyRuntime(target)    the built-in table for a CLI that has none (`legacy: true`)
//   runtimeMatrix({ runtime, target, program, doctor })
//                            -> { editor, browser, native, boot, wasmEmulator }
//     each {available: boolean, reason: string|null, fix: null|'doctor'|'install-emulator'}
//     — never silently applied: a disabled cell says why, and what would fix it.
//   defaultRuntime({ matrix, remembered, preferEditor })
//                            -> 'editor' | 'native' | 'browser' | null  (never guesses Browser
//                               while Editor works; never lands on a disabled cell)
//
//   coerceInput(input, raw)  -> { ok, value, error }     validate one value by kind
//   inputArgs(program, overrides)
//                            -> { args: string[], applied: {NAME: value}, errors: string[] }
//                               `--define NAME=VALUE` for each override that differs from the
//                               program's current value
//
//   runtimeArgs(runtime, target, { x16emu, webLan }) -> string[]   the flags a runtime adds to `8bs run`
//   runKey({dir, program, system, target, runtime})   -> string    identity of a run
//   formatCommand(args)                               -> string    `8bs run c64 --program x` as typed
//
//   class UnitLoader         asks the CLI, caches by config mtime, falls back to legacy
//
// The extension only ever shells out to `8bs run|build|boot|doctor|project|targets`;
// every set the old code kept by hand (which machines have a wasm build, which can boot
// bare, which take --pal) now comes from the machine's own row in `8bs targets --json`.
'use strict';

const fs = require('fs');
const path = require('path');

const RUNTIMES = ['editor', 'browser', 'native'];
const RUNTIME_LABELS = { editor: 'Editor', browser: 'Browser', native: 'Native' };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringOrNull = (value) => (typeof value === 'string' && value !== '' ? value : null);

// ---------------------------------------------------------------------------
// The project
// ---------------------------------------------------------------------------

/**
 * One input (a `define`) as the CLI describes it.
 *
 * @param {unknown} raw
 * @returns {object|null}
 */
function normalizeInput(raw) {
  if (!isObject(raw) || typeof raw.name !== 'string' || raw.name === '') return null;
  const kind = raw.kind === 'bool' || raw.kind === 'string' ? raw.kind : 'int';
  const dflt = raw.default === undefined ? null : raw.default;
  const value = raw.value === undefined || raw.value === null ? dflt : raw.value;
  return {
    name: raw.name,
    kind,
    default: dflt,
    value,
    description: stringOrNull(raw.description),
    source: raw.source === 'config-only' ? 'config-only' : 'source',
  };
}

/**
 * One program of `8bs project --json`.
 *
 * @param {object} raw
 * @param {string} dir the project's directory (entries are relative to it)
 * @param {string[]} projectTargets
 */
function normalizeProgram(raw, dir, projectTargets) {
  const entryRelative = typeof raw.entry === 'string' ? raw.entry : '';
  const targets = Array.isArray(raw.targets) ? raw.targets.filter((t) => typeof t === 'string') : projectTargets;
  return {
    name: raw.name,
    label: stringOrNull(raw.title) ?? raw.name,
    title: stringOrNull(raw.title),
    description: stringOrNull(raw.description),
    group: stringOrNull(raw.group),
    entry: entryRelative ? path.resolve(dir, entryRelative) : '',
    entryRelative,
    entryExists: raw.entryExists !== false,
    targets,
    requires: isObject(raw.requires) ? raw.requires : {},
    definesRead: raw.definesRead !== false,
    defines: (Array.isArray(raw.defines) ? raw.defines : []).map(normalizeInput).filter(Boolean),
    problems: Array.isArray(raw.problems) ? raw.problems.filter((p) => typeof p === 'string') : [],
  };
}

/**
 * Turn the JSON `8bs project --json` prints into a UnitProject.
 *
 * @param {unknown} raw parsed JSON
 * @returns {object} UnitProject
 * @throws {Error} when it is not a project description at all
 */
function normalizeProject(raw) {
  if (!isObject(raw) || typeof raw.version !== 'number' || !Array.isArray(raw.programs)) {
    throw new Error('not an 8bs project description');
  }
  const dir = typeof raw.dir === 'string' ? raw.dir : '';
  const targetRows = (Array.isArray(raw.targets) ? raw.targets : [])
    .filter((row) => isObject(row) && typeof row.id === 'string')
    .map((row) => ({
      id: row.id,
      hardware: isObject(row.hardware) ? row.hardware : {},
      profiles: Array.isArray(row.profiles) ? row.profiles : [],
      locale: stringOrNull(row.locale),
    }));
  const targets = targetRows.map((row) => row.id);
  const programs = raw.programs
    .filter((program) => isObject(program) && typeof program.name === 'string')
    .map((program) => normalizeProgram(program, dir, targets));
  return finishProject({
    source: 'cli',
    legacy: false,
    version: raw.version,
    dir,
    name: stringOrNull(raw.name) ?? path.basename(dir),
    configPath: stringOrNull(raw.configPath),
    hasConfig: raw.hasConfig !== false,
    configError: stringOrNull(raw.configError),
    targets,
    targetRows,
    locales: isObject(raw.locales) ? {
      default: stringOrNull(raw.locales.default),
      fallback: stringOrNull(raw.locales.fallback),
      available: Array.isArray(raw.locales.available) ? raw.locales.available : [],
    } : null,
    systems: (Array.isArray(raw.systems) ? raw.systems : []).filter((s) => isObject(s) && typeof s.name === 'string'),
    problems: (Array.isArray(raw.problems) ? raw.problems : [])
      .filter((p) => isObject(p) && typeof p.message === 'string')
      .map((p) => ({ scope: typeof p.scope === 'string' ? p.scope : 'project', message: p.message })),
    programs,
  });
}

/**
 * A UnitProject from what the regex config reader (projects.cjs) found: for a
 * CLI that predates `8bs project --json`. It has no titles, no inputs and no
 * problems list, and it is as fragile as the reader; `legacy: true` lets the
 * launcher say so rather than pretend.
 *
 * @param {{ name: string, dir: string, configPath: string, entry: string, targets: string[],
 *   programs?: Array<{ name: string, entry: string, targets?: string[]|null }> }} project
 */
function legacyProject(project) {
  const listed = project.programs ?? [];
  const programs = (listed.length > 0 ? listed : [{ name: 'main', entry: project.entry, targets: null }]).map((program) => ({
    name: program.name,
    label: program.name,
    title: null,
    description: null,
    group: null,
    entry: program.entry,
    entryRelative: path.relative(project.dir, program.entry),
    entryExists: true,
    targets: program.targets ? project.targets.filter((t) => program.targets.includes(t)) : project.targets,
    requires: {},
    definesRead: false,
    defines: [],
    problems: [],
  }));
  return finishProject({
    source: 'legacy',
    legacy: true,
    version: 0,
    dir: project.dir,
    name: project.name,
    configPath: project.configPath,
    hasConfig: true,
    configError: null,
    targets: project.targets,
    targetRows: project.targets.map((id) => ({ id, hardware: {}, profiles: [], locale: null })),
    locales: null,
    systems: [],
    problems: [],
    programs,
  });
}

function finishProject(project) {
  const names = project.programs.map((p) => p.name);
  return {
    ...project,
    several: project.programs.length > 1,
    main: names.includes('main') ? 'main' : (project.programs.length === 1 ? project.programs[0].name : null),
  };
}

/** @param {{ programs: Array<{ name: string }> }} unitProject @param {string|null|undefined} name */
function programNamed(unitProject, name) {
  return unitProject.programs.find((p) => p.name === name) ?? null;
}

/**
 * The program a command acts on: `chosen` when the project has it, else its
 * `main`, else the only one. Several programs and no `main` is the one case
 * the toolchain refuses to guess, so this answers null and the caller asks.
 *
 * @returns {object|null} a UnitProgram
 */
function resolveUnit(unitProject, chosen) {
  return programNamed(unitProject, chosen)
    ?? programNamed(unitProject, unitProject.main);
}

// ---------------------------------------------------------------------------
// Runtimes
// ---------------------------------------------------------------------------

const row = (available, reason = null) => ({ available: available === true, reason: available === true ? null : reason });

/**
 * One machine's `runtime` object from `8bs targets --json`, defaulted so a
 * partly-filled row still answers every question.
 *
 * @param {unknown} raw
 */
function normalizeRuntime(raw) {
  if (!isObject(raw)) return null;
  const native = isObject(raw.native) ? raw.native : {};
  return {
    legacy: false,
    native: {
      ...row(native.available, stringOrNull(native.reason) ?? 'no native emulator'),
      emulator: stringOrNull(native.emulator),
      installed: native.installed === true ? true : (native.installed === false ? false : null),
    },
    wasm: row(raw.wasm?.available, stringOrNull(raw.wasm?.reason) ?? 'no wasm build'),
    wasmEmulator: row(raw.wasmEmulator?.available, stringOrNull(raw.wasmEmulator?.reason) ?? 'no real emulator is vendored as WebAssembly for this machine'),
    boot: row(raw.boot?.available, stringOrNull(raw.boot?.reason) ?? 'cannot boot bare'),
  };
}

// The table an older CLI (no `runtime` object in `8bs targets --json`) gets.
// It is the extension's old hand-kept knowledge in ONE place, marked legacy:
// a CLI that reports runtimes always wins over it. The truth for the C64 is
// "no wasm build yet" (docs/project/units.md).
const LEGACY_WASM = new Set(['pet', 'vic20', 'cx16', 'web']);
const LEGACY_WASM_EMULATOR = new Set(['cx16']);
const LEGACY_NO_NATIVE = new Set(['web']);
const LEGACY_EMULATOR = { pet: 'xpet', vic20: 'xvic', c64: 'x64sc', cx16: 'x16emu', c128: 'x128', atari8: 'atari800', nes: 'fceux', mega65: 'xmega65' };

/** @param {string} target */
function legacyRuntime(target) {
  const native = !LEGACY_NO_NATIVE.has(target);
  return {
    legacy: true,
    native: {
      ...row(native, 'the browser has no native emulator; it runs in the browser'),
      emulator: LEGACY_EMULATOR[target] ?? null,
      installed: null,
    },
    wasm: row(LEGACY_WASM.has(target), `no wasm build for ${target} yet`),
    wasmEmulator: row(LEGACY_WASM_EMULATOR.has(target), 'no real emulator is vendored as WebAssembly for this machine'),
    boot: row(native, 'the browser cannot boot bare'),
  };
}

/**
 * The Editor / Browser / Native / Boot cells for one program on one system —
 * what the launcher draws and what a run command checks. A cell that cannot
 * work says why (`reason`) and, when the person can fix it, what would
 * (`fix`: 'doctor' to open Doctor, 'install-emulator' for the emulator).
 *
 * @param {{ runtime?: object|null, target: string, program?: object|null,
 *   doctor?: { notInstalled?: string[], failed?: string[] } | null }} input
 */
function runtimeMatrix({ runtime, target, program = null, doctor = null }) {
  const caps = runtime ?? legacyRuntime(target);
  const cell = (available, reason = null, fix = null) => ({ available, reason: available ? null : reason, fix: available ? null : fix });
  const all = (reason) => ({
    editor: cell(false, reason),
    browser: cell(false, reason),
    native: cell(false, reason),
    boot: cell(false, reason),
    wasmEmulator: cell(false, reason),
    legacy: caps.legacy === true,
  });
  if (program && program.targets.length > 0 && !program.targets.includes(target)) {
    return all(`${program.label} does not target ${target}`);
  }
  const wasm = cell(caps.wasm.available, caps.wasm.reason);

  // The native emulator: "available" is the machine being built in this
  // release; "installed" is the binary being on PATH, which is fixable.
  const emulator = caps.native.emulator ?? 'the emulator';
  const missing = caps.native.installed === false || (doctor?.notInstalled ?? []).includes(target);
  const broken = (doctor?.failed ?? []).includes(target);
  let native;
  if (!caps.native.available) native = cell(false, caps.native.reason);
  else if (missing) native = cell(false, `${emulator} is not installed`, 'install-emulator');
  else if (broken) native = cell(false, `${emulator} is installed but does not pass Doctor`, 'doctor');
  else native = cell(true);

  let boot;
  if (!caps.boot.available) boot = cell(false, caps.boot.reason);
  else boot = native.available ? cell(true) : cell(false, native.reason, native.fix);

  return {
    editor: wasm,
    browser: wasm,
    native,
    boot,
    wasmEmulator: cell(caps.wasmEmulator.available, caps.wasmEmulator.reason),
    legacy: caps.legacy === true,
  };
}

/**
 * Which runtime a program's primary action means. Remembered wins when it
 * still works; with no history it is Editor (Native when `preferEditor` is
 * false — the old `preferWebPreview` setting, honoured only here), then the
 * other of the two. Browser is never chosen for a person while Editor works,
 * and a disabled cell is never chosen at all.
 *
 * @returns {'editor'|'browser'|'native'|null}
 */
function defaultRuntime({ matrix, remembered = null, preferEditor = true }) {
  const works = (id) => matrix[id]?.available === true;
  if (remembered && RUNTIMES.includes(remembered) && works(remembered)) return remembered;
  const order = preferEditor ? ['editor', 'native', 'browser'] : ['native', 'editor', 'browser'];
  return order.find(works) ?? null;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Validate one value for one input by its kind.
 *
 * @param {{ name: string, kind: string }} input
 * @param {unknown} raw a value from a form: a string, number or boolean
 * @returns {{ ok: true, value: number|boolean|string } | { ok: false, error: string }}
 */
function coerceInput(input, raw) {
  if (input.kind === 'bool') {
    if (raw === true || raw === 'true') return { ok: true, value: true };
    if (raw === false || raw === 'false') return { ok: true, value: false };
    return { ok: false, error: `${input.name} is true or false` };
  }
  if (input.kind === 'int') {
    const text = typeof raw === 'number' ? String(raw) : (typeof raw === 'string' ? raw.trim() : '');
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
      return { ok: false, error: `${input.name} is a whole number, 0 or more` };
    }
    return { ok: true, value: Number(text) };
  }
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
    return { ok: false, error: `${input.name} is text` };
  }
  return { ok: true, value: String(raw) };
}

/** `NAME=VALUE` as `--define` takes it. */
const defineText = (name, value) => `${name}=${typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)}`;

/**
 * The `--define` flags for a run: one per override that differs from the
 * value the program already has (its config's, else its source's default).
 * An override for a name the program does not read, or one that does not fit
 * its kind, is reported and left out — the CLI would refuse it anyway, and
 * would name the nearest input, but the form should say so first.
 *
 * @param {{ defines: object[] }} program
 * @param {Record<string, unknown>} overrides
 */
function inputArgs(program, overrides = {}) {
  const args = [];
  const applied = {};
  const errors = [];
  for (const [name, raw] of Object.entries(overrides ?? {})) {
    const input = program.defines.find((d) => d.name === name);
    if (!input) {
      errors.push(`${program.label ?? program.name} has no input ${name}`);
      continue;
    }
    const result = coerceInput(input, raw);
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    if (result.value === input.value) continue;
    args.push('--define', defineText(name, result.value));
    applied[name] = result.value;
  }
  return { args, applied, errors };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * The flags a runtime adds to `8bs run <target>`. Three runtimes, none of
 * which needs another to have run:
 *
 *   native   nothing  (the machine's own emulator)
 *   editor   --web --no-open --port 0   the wasm page, served on loopback
 *                                       for the editor tab to frame
 *   browser  --web                      the wasm page, opened in the system
 *                                       browser
 *
 * `x16emu` (cx16 only) swaps the lightweight wasm page for the vendored real
 * emulator as WebAssembly. The synthetic `web` target is already a browser
 * page: `8bs run web` is its Browser run, and `--no-open` its Editor run.
 *
 * @param {'editor'|'browser'|'native'} runtime
 * @param {string} target
 * @param {{ x16emu?: boolean, webLan?: boolean }} [options]
 * @returns {string[]}
 */
function runtimeArgs(runtime, target, { x16emu = false, webLan = true } = {}) {
  if (runtime === 'native') return [];
  const local = webLan ? [] : ['--local'];
  if (target === 'web') {
    return runtime === 'editor' ? ['--no-open', '--port', '0', ...local] : ['--port', '0', ...local];
  }
  const emulator = x16emu ? ['--x16emu'] : [];
  return runtime === 'editor' ? ['--web', '--no-open', '--port', '0', ...emulator] : ['--web', ...emulator];
}

/**
 * The identity of a run: the same program, on the same system, in the same
 * runtime, is the same run (starting it again replaces it); a different
 * runtime is another run that lives beside it.
 */
function runKey({ dir, program = null, system = null, target = null, runtime = 'native' }) {
  return [dir, program ?? '', system || target || '', runtime].join('|');
}

/** A shell-ish rendering of `8bs <args>` for the launcher's Command line. */
function formatCommand(args) {
  const quote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
  return ['8bs', ...args.map(quote)].join(' ');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Asks the project's own CLI what the project is, and remembers the answer
 * until the config changes. An older CLI (no `project --json`: it prints
 * usage or exits 2) falls back to the regex reader's view, flagged legacy.
 *
 * `exec(project, args)` runs `8bs <args>` in the project's directory and
 * resolves `{ stdout, code }` (never rejects); runner.cjs supplies it, tests
 * supply a fake.
 */
class UnitLoader {
  /**
   * @param {{ exec: Function, mtime?: (file: string) => number, log?: (line: string) => void }} options
   */
  constructor({ exec, mtime = defaultMtime, log = () => {} }) {
    this.exec = exec;
    this.mtime = mtime;
    this.log = log;
    this.cache = new Map();
  }

  /** Forget what is known — after a refresh, or a source file was saved. */
  invalidate(dir) {
    if (dir === undefined) this.cache.clear();
    else this.cache.delete(dir);
  }

  /**
   * @param {object} project a projects.cjs Project (has dir, configPath, toolchain, programs…)
   * @param {{ defines?: boolean }} [options] `defines: false` skips linking each program
   * @returns {Promise<object>} UnitProject
   */
  async load(project, { defines = true } = {}) {
    const stamp = `${project.configPath}:${this.mtime(project.configPath)}:${defines}`;
    const cached = this.cache.get(project.dir);
    if (cached && cached.stamp === stamp) return cached.pending;
    const pending = this.read(project, defines);
    this.cache.set(project.dir, { stamp, pending });
    return pending;
  }

  async read(project, defines) {
    if (!project.toolchain) return { ...legacyProject(project), legacyReason: 'no toolchain' };
    const args = ['project', '--json', ...(defines ? [] : ['--no-defines'])];
    const { stdout, code } = await this.exec(project, args);
    try {
      return normalizeProject(JSON.parse(stdout));
    } catch (error) {
      // Exit 1 with a JSON body is a config that would not load: still a
      // project description, handled above by parsing the body. Anything
      // else is a CLI without the command.
      const reason = code === 0 ? error.message : `8bs project --json exited ${code}`;
      this.log(`8bs project --json unavailable (${reason}); reading the config without the CLI`);
      return { ...legacyProject(project), legacyReason: reason };
    }
  }
}

function defaultMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

module.exports = {
  RUNTIMES,
  RUNTIME_LABELS,
  UnitLoader,
  coerceInput,
  defaultRuntime,
  defineText,
  formatCommand,
  inputArgs,
  legacyProject,
  legacyRuntime,
  normalizeProject,
  normalizeRuntime,
  programNamed,
  resolveUnit,
  runKey,
  runtimeArgs,
  runtimeMatrix,
};
