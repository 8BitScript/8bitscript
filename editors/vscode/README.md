# 8BitScript for VS Code and Cursor

Syntax highlighting plus a real language server for `.8bs` files. The
extension itself is still a thin client: it finds the project's `8bs`
toolchain and runs `8bs lsp --stdio`, and every diagnostic, hover, and
completion it shows comes from `@8bitscript/compiler` through that server —
not from anything reimplemented here. See
[Editor support](../../docs/language-server.md) for the split between the
compiler, the language server, and this extension.

## What it does

- Registers `.8bs` as the language **8BitScript**
- Colours comments, strings, numbers, types, keywords, declarations, and calls
- `//` line comments and `/* */` blocks, so comment-toggling works
- Bracket matching, auto-closing pairs, and `// #region` folding
- Starts the language server (`8bs lsp --stdio`) when a `.8bs` file is open
  and the toolchain is installed, giving you:
  - **Diagnostics** — lexical, syntax, and range errors, as you type
  - **Hover** — documentation for built-in types (`utinyint`, `int`, ...) and
    constructs (`volatile`, `ptr`, `array`, `asm6502`, `@address`)
  - **Completion** — built-in type names in type position (after `:` or
    inside `ptr<...>`/`array<...>`/`volatile<...>`)

If no toolchain is found, the extension says so and falls back to syntax
highlighting alone — see "Installing it while developing" below.

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
the window is the whole development loop. If the editor does not pick up the
symlink, copy the directory instead of linking it — some builds scan for real
directories. Remove it with `rm` on the link; nothing else is touched.

## Publishing it later

Distribution is a `.vsix` built with `@vscode/vsce` and either uploaded to the
marketplace or installed with `cursor --install-extension <file>.vsix`. That is
not set up yet, and it is not worth setting up until the grammar has settled.
