---
title: Editor support
nav_order: 4
---

# Editor support

8BitScript ships its own language server. Errors, built-in hover, and built-in
completion come from the compiler itself rather than from an editor plugin
that reimplements the language; go-to-definition and completion over your own
code follow once a binder exists.

## The split

```
                 8BitScript project
                          |
                          v
                @8bitscript/compiler
                 parser + type checker
                          |
              +-----------+-----------+
              |                       |
              v                       v
        CLI compiler          language server
           `8bs`                 `8bs lsp`
                                      |
                                     LSP
                                      |
                          +-----------+-----------+
                          |                       |
                          v                       v
                   Cursor / VS Code         other editors
```

The compiler holds the intelligence. The language server is an adapter that
exposes it over the Language Server Protocol. The editor extension is a cable:
it tells the editor that `.8bs` is a language and starts `8bs lsp --stdio`.

The same rule covers building and running. The VS Code extension adds an
8BitScript icon to the Activity Bar whose side bar picks a system and region
and lists the projects that can run there, but each Run button only
starts the `8bs run` or `8bs build` command you would otherwise type, in the
project's own directory with the project's own toolchain.

The extension deliberately contains no language logic. Putting a checker there
would mean two implementations of every rule and an editor that disagrees with
CI.

## What works today

Diagnostics. Open a `.8bs` file and errors appear as you type, from the same
`analyze()` call `8bs check` makes:

```
let score: u8 = 300;
                ~~~
                300 does not fit in u8 (0..255)
```

That covers lexical problems, syntax errors, the integer range rule, and
unresolved imports —
a package you have not installed, one that is not an 8BitScript package, or a
subpath a package does not export, is underlined on the import line. Import resolution needs a saved file: an
untitled buffer still gets every other diagnostic.

`frames(...)` diagnostics (an invalid argument, a unit it doesn't know —
`seconds` is the only one — a duration that rounds to zero frames, one that
isn't exact, a decimal literal used outside `frames(...)`, or a declaration
that shadows a reserved name) use the same
project-level `frameRate` a real build would (`8bs.config.ts`, default 60):
the server walks upward from the open file looking for `8bs.config.ts`, the
same way it would be found from any file inside the project, so the editor
and `8bs build` never disagree about what a duration folds to. An untitled
buffer, with no file on disk to walk up from, assumes the default 60.

Hover and a first slice of completion, both for built-in constructs. Hovering
a primitive type (`utinyint`, `u8`, `int`, ...), `volatile`, `ptr`, `array`,
`asm6502`, `@address`, `memory.read`/`memory.write`, `frames(...)`, the
`seconds` unit inside it, or `waitFrame()` explains it in place:

```
let lives: utinyint = 3;
           ~~~~~~~~
           utinyint
           Unsigned 1-byte integer.
           Size: 1 byte / 8 bits
           Range: 0 through 255
           Low-level alias: u8
```

Completion offers the built-in type names — canonical spellings
(`tinyint`/`utinyint`/`smallint`/`usmallint`/`mediumint`/`umediumint`/`int`/`uint`)
first, then their low-level aliases (`i8`, `u8`, ...) — wherever a type can
syntactically appear: after a `:` annotation, or inside `ptr<...>`,
`array<...>`, or `volatile<...>`. See [the compiler](compiler.md#primitive-integer-types)
for what each type means and how the aliasing works.

Both come from one compiler API (`getHoverInfo`/`getCompletions` in
`@8bitscript/compiler`) that recognises built-in syntax only — there is no
binder yet, so a user's own variables, functions, and imports have no hover or
completion of their own. That, along with go-to-definition and semantic
tokens, waits on a binder and a symbol table — see [the compiler](compiler.md).
It is API work rather than a second compiler once those land, which is the
whole reason for this architecture.

## Two layers of highlighting

Basic colouring — keywords, types, strings, numbers, and the reserved builtins
(`frames(...)`, `waitFrame()`) — comes from a TextMate grammar in
the editor extension (`editors/vscode/syntaxes/8bs.tmLanguage.json`). It is fast, works with no server running, and
does not need to understand the program.

Semantic highlighting comes later from the language server, which can tell a
constant from a variable because it knows what names refer to. It layers over
the grammar rather than replacing it.

## Using it in your editor

### Cursor and VS Code

The extension lives at `editors/vscode/` in this repository. Link it in and
reload the window:

```bash
ln -s "$PWD/editors/vscode" ~/.cursor/extensions/8bitscript.8bitscript-lang-0.0.0
```

Use `~/.vscode/extensions/` for VS Code, and run it from the repository root
either way. Then **Developer: Reload Window**, and open a `.8bs` file.

The extension looks for `node_modules/.bin/8bs` in the workspace folder. If the
toolchain is not installed it says so and stops:

```
8BitScript compiler not found. Run: pnpm add -D @8bitscript/cli
```

#### The side bar

The extension adds an **8BitScript** icon to the Activity Bar, the strip of
icons down the left edge of the window. Its side bar has two sections. **Run
Settings** is three dropdowns — the system to run on (`vic20`, `c64`, `web`),
the region for the Commodore machines (NTSC or PAL), and how the project list
is laid out — plus, when the toolchain comes from a checkout of this
repository, a checkbox that adds the repository's `examples/` to the list.
**Projects** lists every directory in the workspace that has an
`8bs.config.ts`, which is the project manifest the CLI reads for the entry
file and the target list.

```
RUN SETTINGS
System [ vic20 ▾ ]   Region [ NTSC ▾ ]
View   [ Runnable on the selected system ▾ ]

PROJECTS  runnable on vic20 · NTSC
  borders           examples/borders          Run  Build
  counter           examples/counter          Run  Build
  hello-vic         examples/hello-vic        Run  Build
```

The default layout lists only the projects that can run on the selected
system, one row each, so a run is one click after the dropdowns. The other
two layouts expand every project into its systems, or every system into its
projects. **Run** starts `8bs run <target>` and **Build** starts `8bs build
--target <target>` as an editor task, in a terminal, from the project's
directory; a row's context menu offers NTSC and PAL explicitly. A running
row shows a **Stop** button that ends the task and the emulator with it. The
view's title bar has **Doctor**, which runs `8bs doctor`, and **Refresh**.

The same runs are available as tasks of type `8bs`, so a favourite can be
written in `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "8bs",
      "command": "run",
      "project": "examples/borders",
      "target": "c64",
      "pal": true,
      "label": "borders on a PAL C64"
    }
  ]
}
```

`command` is `run`, `build`, or `doctor`; `project` is relative to the
workspace folder and defaults to the folder itself; `pal` is optional.

### Any other editor

There is nothing special to install. The server speaks LSP over stdio, so
point any LSP client at:

```bash
8bs lsp --stdio
```

That is the same command the Cursor extension runs. Neovim, Zed, Helix, and
Emacs all take a command like that in their language-server configuration.

## Checking without an editor

```bash
8bs check src/main.8bs
```

Same rules, same codes, same messages — printed instead of drawn. This is what
CI runs, and it is how the diagnostics are tested.
