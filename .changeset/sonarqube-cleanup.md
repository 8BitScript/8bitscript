---
"8bitscript-lang": patch
"@8bitscript/cli": patch
"@8bitscript/language-server": patch
---

Fixes real SonarCloud issues (not gate failures — every PR's quality gate already passed; these are per-file code smells flagged in the project dashboard):

- **Unhandled promise rejections** (`javascript:S9383`, 16 sites across the VS Code extension, the CLI's dev-server/controller HTTP handlers, and the language server): an async call in an event handler or request callback with nothing to catch a rejection. Each now logs (and, for a direct user action, shows a VS Code error message) instead of risking an unhandled rejection taking down the whole extension host, dev server, or language server on one bad input.
- **Super-linear regex backtracking** (`javascript:S8786`, 4 sites in `scripts/vice-catalog.mjs`): an unbounded `.+`/`+`/`*` next to another quantifier or a literal it could also match. Fixed with plain string search (`indexOf`/`lastIndexOf`) where the pattern was really "first X to last Y", and bounded quantifiers everywhere else (VICE's own `--help` text is always short, so a generous cap changes no real match while removing the backtracking shape entirely).

No behavior change: every affected package's own test suite passes unchanged (vscode extension 377/378, the 1 skip pre-existing; cli 34/34; language-server 34/34; the vice-catalog script's own 13/13).
