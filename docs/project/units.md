---
title: Work units, and how an editor runs them
nav_order: 90
---

# Work units, and how an editor runs them

*Design note, 2026-10-04. Why the toolchain grew `8bs project --json`, a
`runtime` object on every machine in `8bs targets --json`, and
`#define`/`--define` — and what an editor is expected to do with them.*

A project is rarely one program. A game has a lobby, a few mini-games, a
sound test, a screen for checking the art; the person working on one wants to
run *that one*, on a chosen machine, in a chosen way, with the settings it
needs, without running the rest. This page names the parts, gives the shapes
the CLI prints, and says what is not decided yet.

## The words

| Word | Means | Where it lives |
| --- | --- | --- |
| **Project** | The directory with an `8bitscript.config.8bs`. | the config |
| **Program** | One thing the project builds, from its own `.8bs` entry — the unit an editor lets you run. | `programs` in the config |
| **System** | A machine plus the hardware fitted to it (`--profile`, `--hardware`, `--pal`); a name for that arrangement. | `systems`, or a machine's own name |
| **Runtime** | *How* a system is run: natively in its own emulator, as a wasm page (in an editor tab or in a browser), as the real emulator in wasm, or booted bare. | the machine package, via `8bs targets --json` |
| **Define** | A value a build is handed — a seed, a flag, a starting amount. | `#define` in the source; `define` in the config; `--define` on the command line |

"Program" was already the config's word and the CLI's (`--program`), and
`docs/project/baseline.md` rejects *edition*, *tier* and *port* for machine
builds on purpose; the editor calls a program a **work unit** or just a
"program" and does not need a new noun for it.

## Run this program, on this system, this way

Three independent choices, which the editor offers as three independent
controls — never one that implies another:

1. **Which program.** `programs`, from `8bs project --json`. A program's own
   `targets` narrow the machines it can run on.
2. **Which system.** The machine, and a named system or hardware on it.
3. **Which runtime.** From the machine's `runtime` object: native, wasm,
   real-emulator-in-wasm. Each is a command that does not need another to
   have run first:

   | Runtime | Command |
   | --- | --- |
   | native emulator | `8bs run <target> --program <p>` |
   | wasm page (editor tab *or* external browser — whichever opens the URL) | `8bs run <target> --program <p> --web --no-open`, then open the printed URL |
   | the real x16emu as WebAssembly (cx16 only) | `8bs run cx16 --program <p> --web --x16emu --no-open` |
   | bare machine, nothing loaded | `8bs boot <target>` |

   plus `--define NAME=VALUE` for each value the user set, and `--locale`.

## `8bs project --json`

Read by the CLI's own loader — no regular expressions over the config —
and, for the defines, by the compiler itself, which links each program once
(about a second for twenty programs; `--no-defines` skips it).

```jsonc
{
  "version": 1,                       // bumped when a field changes meaning; adding one does not bump it
  "hasConfig": true,                  // false: no config here; the one default program is described
  "configPath": "/…/8bitscript.config.8bs",
  "configError": null,                // set (and exit 1) when a config exists and will not load
  "dir": "/…/vegas-nights", "name": "vegas-nights",
  "frameRate": 60,
  "baseline": { "target": "c64", … } | null,
  "targetsListed": true,              // false: the project lists none, so every machine this release builds for
  "targets": [{ "id": "c64", "hardware": {}, "profiles": [], "locale": null }, …],
  "locales": { "default": "en", "fallback": "en", "available": ["en", "de"] } | null,
  "locale": null,
  "requires": {},
  "systems": [{ "name": "…", "layer": "clone" | "machine" | "advertised", "target": "c64", "profile": null, "hardware": {}, "region": "ntsc" }],
  "problems": [{ "scope": "programs" | "systems" | "baseline" | "requires" | "frameRate" | "i18n", "message": "…" }],
  "programs": [{
    "name": "slot5x5",
    "entry": "src/labs/slot5x5/main.8bs", "entryExists": true,
    "title": "Slot 5×5" | null, "description": "…" | null, "group": "Slots" | null,   // display only
    "targetsDeclared": ["pet", "c64"] | null,   // as written; null: the project's
    "targets": ["pet", "c64"],                  // resolved, and only machines this release builds
    "requires": {},
    "definesRead": true,                        // false with --no-defines, or when no machine could link it
    "definesReadOn": "c64",
    "defines": [
      { "name": "SEED", "kind": "int" | "bool" | "string",
        "default": 10,                          // from the source's #define; null for a config-only name
        "value": 7,                             // the config's, else the default
        "description": "…" | null,
        "source": "source" | "config-only" }    // config-only: the config sets it, no #define reads it
    ],
    "problems": ["…"]                           // this program's, e.g. it does not link on the machine it was read on
  }]
}
```

Exit codes: **0** — described (anything wrong *in* the project is a
`problems` entry, so a typo in one program costs the reader that program and
not the picture); **1** — a config exists and could not be loaded (the JSON
still prints, with `configError`); **2** — bad arguments. A directory with no
config is exit 0 with `"hasConfig": false`.

An editor should treat `"problems"` as things to show beside the thing they
are about, not as a reason to disable the whole panel.

## `8bs targets --json`: a `runtime` object on every machine

```jsonc
"runtime": {
  "native":       { "available": true,  "emulator": "x64sc", "installed": true, "reason": null },
  "wasm":         { "available": true,  "reason": null, "limits": ["text mode only: sprites, bitmap, multicolour … are not drawn", "…"] },
  "wasmEmulator": { "available": false, "reason": "no real emulator is vendored as WebAssembly for this machine" },
  "boot":         { "available": true,  "reason": null }
}
```

- `native.installed` is whether the binary is on `PATH` (`null` when there is
  nothing to look for — the web). It is a hint for greying a button, not a
  promise: `8bs doctor --json` is the authority on emulators and their ROMs.
- `wasm.available` is **declared by each machine package** (`emulator.wasm`
  in its `package.json`) and **held to the truth by a test** that builds a
  small program for every machine this release builds, through the wasm
  backend (`8bs build --web`): the claim and the build must agree. Today the
  PET, VIC-20, C64, X16 and web all build. The extension used to keep a hand
  set of "web-ready" machines; this replaces it.
- `wasm.limits` is a list of plain sentences, the package's own, saying what
  the page does not model yet (the C64's wasm build draws text mode only: no
  sprites, bitmap or sound). A wasm build is a model of the machine, not the
  machine, and a launcher should show the limits beside the button rather
  than let a program that needs a sprite look broken. It is `[]` when the
  package declares none, and always `[]` when `available` is false.
- A machine this release does not build is unavailable in every runtime,
  with the reason `not built in this release`.

## Defines: a unit with settings, not a copy of the unit

Before, a variant of a program — the same game from a fixed seed, or forced
into its bonus round — was another entry file that called the shared code
with literals; a project can have twenty programs for that reason. A define
makes the variant a *value*:

```ts
// in the source
const SEED: utinyint = #define("SEED", 10);
const FORCE_BONUS: bool = #define("FORCE_BONUS", false);
```
```ts
// in the config, for one program every time
programs: { slot5x5: { entry: '…', define: { SEED: 10, FORCE_BONUS: { value: true, description: 'Start in the bonus' } } } }
```
```sh
# for one run
8bs run c64 --program slot5x5 --define SEED=42 --define FORCE_BONUS=true
```

An editor lists a program's `defines` from `project --json` as small
controls — a number box, a checkbox, a text box, by `kind` — pre-filled with
`value`, and passes the ones the user changed as `--define`. It can show a
"reset" that returns a control to `default`. The build records what it was
built with (`dist/.8bs-last-<target>.json` → `defines`), so the editor can
say "built with SEED=42".

A different value is a different build — the define folds to a literal, so
a program that reads none is byte-identical to before — and a name the
program never reads is an error naming the nearest one it does, so a typo
cannot silently do nothing. The rules are in
[core.md §1.11](../language/core.md#111-values-the-build-is-handed).

Existing projects are not migrated by this. A project that has a program per
variant can fold them into defines at its own pace.

## Not decided here

- **Whether the editor shows a "Run in the editor" tab for a wasm page or only
  opens the URL.** The CLI prints a URL either way (`--no-open`); an editor
  tab is a webview framing it.
- **Negative and wider define values.** The default is a non-negative whole
  number, `true`/`false`, or a string; there is no signed literal to fold
  into yet.
- **Per-program entries in the table form of `8bs targets`.** `8bs project`
  is the command for them.
