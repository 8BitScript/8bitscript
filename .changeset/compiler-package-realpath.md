---
"@8bitscript/compiler": patch
---

`8bs check` and the editor no longer report a false `8BS2001 for the c128 target: cannot find package '@8bitscript/c128'` on every import of `@8bitscript/text`, `screen` or `input` in a project installed with pnpm. A package that delegates an entry to a machine package now resolves the delegation from its real directory, where pnpm puts the machine packages it depends on. Without a machine, `8bs check` and the language server validate every machine's branch of such a package; they needed all of them to be reachable from the symlink in the project's `node_modules`, which only a project with a local-checkout pointer (`.8bitscript/toolchain.json`) ever was. The false error also hid the real diagnostics and hover in the importing file. Builds were never affected: they name one machine.
