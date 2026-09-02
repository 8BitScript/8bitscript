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
a package you have not installed, or one that is not an 8BitScript package, is
underlined on the import line. Import resolution needs a saved file: an
untitled buffer still gets every other diagnostic.

Hover and a first slice of completion, both for built-in constructs. Hovering
a primitive type (`utinyint`, `u8`, `int`, ...), `volatile`, `ptr`, `array`,
`asm6502`, or `@address` explains it in place:

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

Basic colouring — keywords, types, strings, numbers — comes from a TextMate
grammar in the editor extension. It is fast, works with no server running, and
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
