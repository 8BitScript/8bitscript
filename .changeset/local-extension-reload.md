---
"8bitscript-lang": patch
---

A source-checkout install watches `editors/vscode` and prompts **Rebuild the local extension** instead of compiling in the background. **Reload this window** appears only after that rebuild finishes. A window reload still compiles a stale `src/` so Developer: Reload Window cannot load yesterday's bundle. `pnpm --filter 8bitscript-lang run link-local` replaces a pinned VSIX copy with a symlink of this tree — a `.vsix` install does not auto-update from the gallery.

Bundling no longer leaves Controller Setup reading `dist/controllerProfile.cjs` from a path esbuild does not write: the file is copied next to the bundle, and a checkout falls back to `src/` so activate cannot ENOENT.
