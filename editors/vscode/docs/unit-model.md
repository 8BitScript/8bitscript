# The unit model: what the launcher is a view of

*Design note for the launcher redesign. The control-to-command contract and the
screens are in the design prototypes (draft PR #310); this note is the data and
command layer under them, written so the launcher view and the run commands can
be built in parallel.*

A person runs a **program** of a **project**, on a **system**, in a **runtime**,
with its **inputs**. Everything below is that sentence made into code.

| Word | Is | Comes from |
| --- | --- | --- |
| Project | a directory with an `8bitscript.config.8bs` | the workspace |
| Program | a work unit: its own entry, targets, title, group, inputs | `programs` in the config, via `8bs project --json` |
| System | a machine plus the hardware fitted to it (or a named system) | `targets`, `systems`; the launcher's System selector |
| Runtime | `editor` (wasm in an editor tab), `browser` (wasm in the system browser), `native` (the machine's own emulator) | the machine's `runtime` object in `8bs targets --json` |
| Input | one `define` the program reads | `programs.<name>.define` / `#define(...)`, via `8bs project --json` |

## Where things live

| File | Role | Touches `vscode`? |
| --- | --- | --- |
| `src/units.cjs` | The pure model: `normalizeProject`, `runtimeMatrix`, `defaultRuntime`, `inputArgs`, `runtimeArgs`, `UnitLoader`. API documented at the top of the file. | no |
| `src/unitState.cjs` | Per-program memory in `workspaceState`: last runtime, last system, input overrides, open disclosures. | no (the memento is injected) |
| `src/runner.cjs` | Spawns the CLI, holds the run registry, registers the commands. | yes |
| `src/projects.cjs` | The config reader (the legacy fallback) and `commandArgs`. | no |

The extension shells out to `8bs run|build|boot|doctor|project|targets` and
nothing else. Every set it used to keep by hand (`WEB_PREVIEW_READY`,
`NO_BARE_EMULATOR`, which machines take `--pal`) is derived from the CLI now;
the old sets stay exported for the views that have not moved yet and are
marked deprecated.

## The three runtimes

None needs another to have run. Each is its own command:

| Runtime | Command id | CLI |
| --- | --- | --- |
| Editor | `8bitscript.runEditor` | `8bs run <t> --program <p> --web --no-open --port 0` — the Preview tab frames the printed URL |
| Browser | `8bitscript.runBrowser` | `8bs run <t> --program <p> --web` — the CLI opens the system browser; no tab |
| Native | `8bitscript.runNative` | `8bs run <t> --program <p>` |

For the X16, `x16emu: true` swaps the lightweight wasm page for the vendored
real emulator as WebAssembly (`--web --x16emu`). For the synthetic `web` target,
`8bs run web` *is* the Browser run and `--no-open` its Editor run. `Boot` is now
`8bitscript.openBareEmulator`.

All of them (and `8bitscript.run`, which forwards) take one argument object:

```ts
{
  project?: Project | string,   // a Project, or its directory; default: the selected one
  program?: string,             // default: the one chosen in the launcher, else main
  system?: string,              // a machine id, or a named system's name; default: the selected one
  runtime?: 'editor'|'browser'|'native',   // runUnit and run only; the others fix it
  inputs?: { NAME: value },     // overrides; default: what the launcher has remembered
  locale?: string,
  x16emu?: boolean,
}
```

`8bitscript.run` with no `runtime` uses the one remembered for that program,
else Editor (Native if the deprecated `preferWebPreview` setting is off), and
falls through to whatever works. It never applies the old hidden
"web-ready machines" rule. A cell that does not work is not run: the person is
told why, and offered the fix if there is one.

## What the launcher view asks the runner for

```ts
projects.unitProject(project)         // Promise<UnitProject>  (cached by config mtime)
projects.matrix(project, program, target)   // Promise<runtimeMatrix result>
projects.unitState                    // UnitState
projects.running.list()               // [{ runId, dir, program, target, system, runtime,
                                      //    command, argv, commandLine, name, startedAt, web }]
projects.running.stopRun(runId)
```

Runs are keyed by `(project, program, system, runtime)`: starting the same run
again replaces it; another runtime of the same program lives beside it, so
Editor and Native can be compared side by side. One limit: the CLI writes one
last-run report per machine and mode (`dist/.8bs-last-<target>[-web].json`), so
two WASM runs of the same machine share the live-status panel; the most recent
wins. The tab keeps the URL it was given.

## State

`workspaceState`, never `settings.json`: `launcher.runtime`, `launcher.system`,
`launcher.inputs`, `launcher.ui`, each `{ [projectDir]: { [program]: value } }`.
`preferWebPreview` is honoured once, as the default runtime for a program with
no history, and ignored after that.

## Falling back

An older pinned CLI has neither `8bs project --json` nor the `runtime` object in
`8bs targets --json`. The extension then reads `programs` and `targets` with
the old regex reader and takes runtimes from one small built-in table, and says
so: `UnitProject.legacy` is `true`, a program's `definesRead` is `false` (its
inputs are unknown, not empty), and `runtimeMatrix(...).legacy` is `true`. The
launcher shows no Inputs section for those.
