---
'@8bitscript/compiler': patch
'@8bitscript/cli': patch
'@8bitscript/language-server': patch
'8bitscript-lang': patch
---

The compiler, linker, catalog and editor features now read the new Rust-style syntax. The old lexer and parser live only inside `8bs migrate`. Messages say `fn`, `mod`, `pub`, `let mut` and `::`; `use` paths resolve by extension in the language server, and the scope helpers moved to `@8bitscript/compiler/scopes`. The config file is `8bitscript.config.ts` (or the older `8bs.config.ts`); the `.8bs` config name is gone: a project with only `8bitscript.config.ts` gets a clear error naming the rename, and `8bs migrate` renames it.
