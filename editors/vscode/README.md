# 8BitScript for VS Code and Cursor

Syntax highlighting for `.8bs` files. That is the whole extension — there is no
language server, no diagnostics, and no formatter, because there is no compiler
to power them yet.

## What it does

- Registers `.8bs` as the language **8BitScript**
- Colours comments, strings, numbers, types, keywords, declarations, and calls
- `//` line comments and `/* */` blocks, so comment-toggling works
- Bracket matching, auto-closing pairs, and `// #region` folding

Hexadecimal and binary literals are highlighted in both the C spelling
(`0xC000`, `0b10110000`) and the assembly spelling (`$C000`, `%10110000`),
since either could end up being the one 8BitScript uses.

## The grammar is provisional

8BitScript's syntax is not specified yet. `syntaxes/8bs.tmLanguage.json` covers
the TypeScript-derived surface the project documentation actually shows, plus
the integer types a 6502 target needs. A keyword the language turns out not to
have simply never matches, so a wrong guess costs a word that does not colour
rather than a broken file.

Inline-assembly and aggregate-type keywords are deliberately absent: their
spelling is not decided, and picking one here would make an editor plugin the
place a language decision accidentally got made.

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
