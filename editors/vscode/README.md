# 8BitScript for VS Code and Cursor

Syntax highlighting, a real language server, and a project runner for `.8bs`
files. The extension itself is still a thin client: it finds the project's
`8bs` toolchain and runs `8bs lsp --stdio`, and every diagnostic, hover, and
completion it shows comes from `@8bitscript/compiler` through that server —
not from anything reimplemented here. The same goes for building and running:
the sidebar view only ever starts the `8bs run` and `8bs build` commands you
would otherwise type. See [Editor support](../../docs/language-server.md) for
the split between the compiler, the language server, and this extension.

## What it does

- Registers `.8bs` as the language **8BitScript**
- Colours comments, strings, numbers, types, keywords, declarations, and calls
- `//` line comments and `/* */` blocks, so comment-toggling works
- Bracket matching, auto-closing pairs, and `// #region` folding
- Starts the language server (`8bs lsp --stdio`) when a `.8bs` file is open
  and the toolchain is installed, giving you:
  - **Diagnostics** — lexical, syntax, and range errors, as you type
  - **Hover** — documentation for built-in types (`utinyint`, `int`, ...) and
    constructs (`volatile`, `ptr`, `array`, `asm6502`, `@address`,
    `memory.read`/`memory.write`)
  - **Completion** — built-in type names in type position (after `:` or
    inside `ptr<...>`/`array<...>`/`volatile<...>`)

If no toolchain is found, the extension says so and falls back to syntax
highlighting alone — see "Installing it while developing" below.

## The projects view

An **8BitScript** section appears in the Explorer sidebar, under the file
tree, whenever the workspace has an 8BitScript project in it. It lists every
project and, under each, the systems that project targets:

```
8BITSCRIPT                                   ⟳ ♥
▾ border            examples/border
    vic20  NTSC                              ▶ 🔧
    c64    NTSC                              ▶ 🔧
▾ counter           examples/counter
    vic20  NTSC                              ▶ 🔧
    c64    NTSC                              ▶ 🔧
    web                                      ▶ 🔧
```

A project is any directory containing an `8bs.config.ts`; that file is
already the manifest the CLI reads for the entry file and the target list,
so the view uses it as the marker rather than a second list to maintain. A
`package.json` on its own does not count — every package in a monorepo has
one. The search skips `node_modules`, and the view refreshes itself when a
config file is added, removed, or edited; the ⟳ button forces a rescan.

Each target row has two inline buttons: **Run** (`8bs run <target>`) and
**Build** (`8bs build --target <target>`). For `vic20` and `c64` those use
the region in the `8bitscript.region` setting — NTSC unless you change it —
and the row's right-click menu offers *Run (NTSC)*, *Run (PAL)*, *Build
(NTSC)*, and *Build (PAL)* explicitly. Each run opens as a task in its own
terminal, started in the project's directory with the project's own
`node_modules/.bin/8bs`, so what you see is exactly what the CLI prints. A
target that is running shows a spinner and a **Stop** button, which
terminates the task (and with it the emulator).

The project row itself opens the entry `.8bs` file when clicked, and its
right-click menu has *Open 8bs.config.ts*, *Reveal in Explorer*, and *Open
in Integrated Terminal*. The ♥ button in the view's title runs `8bs doctor`,
which reports whether the VICE and LLVM-MOS installs each target needs are
in place.

From the command palette, **8BitScript: Run** and **8BitScript: Build** ask
which project and system when there is more than one; **8BitScript: Doctor**
and **8BitScript: Refresh Projects** are there too.

Every run and build is also a task of type `8bs`, so **Tasks: Run Task**
lists them, and a favourite can be pinned in `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "8bs",
      "command": "run",
      "project": "examples/border",
      "target": "c64",
      "pal": true,
      "label": "border on a PAL C64"
    }
  ]
}
```

`project` is relative to the workspace folder and defaults to the folder
itself; `command` is `run`, `build`, or `doctor`; `pal` is optional.

A project whose toolchain is not installed is still listed, marked with a
warning icon and *toolchain not installed*; running it explains how to fix
that (`pnpm install` in the project, or `pnpm add -D @8bitscript/cli`).

Hexadecimal and binary literals are highlighted in both the C spelling
(`0xC000`, `0b10110000`) and the assembly spelling (`$C000`, `%10110000`),
since either could end up being the one 8BitScript uses.

## The grammar is provisional

8BitScript's syntax is not fully specified yet. `syntaxes/8bs.tmLanguage.json`
covers the TypeScript-derived surface the project documentation actually
shows, the primitive integer types (both the friendly spelling — `utinyint`,
`int`, ... — and the low-level `u8`/`i8`-style aliases), and the hardware
escape hatches that already exist: `@address` decorators,
`volatile`/`ptr`/`array`, and `asm6502` blocks. A keyword the language turns
out not to have simply never matches, so a wrong guess costs a word that does
not colour rather than a broken file.

This is still only lexical colouring — it has no idea what a name refers to.
The language server layers semantic information over it once it has a binder
to draw on; until then, hover and completion (see above) are the only
compiler-backed intelligence in the editor.

## Installing it while developing

Link this directory into the editor's extensions folder, then reload the window.

Cursor:

```bash
ln -s "$PWD/editors/vscode" ~/.cursor/extensions/8bitscript.8bitscript-lang-0.0.0
```

VS Code:

```bash
ln -s "$PWD/editors/vscode" ~/.vscode/extensions/8bitscript.8bitscript-lang-0.0.0
```

Run either from the repository root. Then **Developer: Reload Window** from the
command palette, open a `.8bs` file, and check that the language indicator in
the status bar reads *8BitScript*.

A symlink is used rather than a copy so that editing the grammar and reloading
the window is the whole development loop. The projects view has a `node --test`
suite for the part that does not need the editor — config reading, toolchain
lookup, and the command each button runs — under `test/`; `pnpm test` from the
repository root runs it along with everything else. If the editor does not pick up the
symlink, copy the directory instead of linking it — some builds scan for real
directories. Remove it with `rm` on the link; nothing else is touched.

## Publishing it later

Distribution is a `.vsix` built with `@vscode/vsce` and either uploaded to the
marketplace or installed with `cursor --install-extension <file>.vsix`. That is
not set up yet, and it is not worth setting up until the grammar has settled.
