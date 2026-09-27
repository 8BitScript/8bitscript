---
"8bitscript-lang": minor
---

"8BitScript: Preview On…" opens any project on any of its `--web`-capable targets in an editor tab — not just Studio, not just cx16.

The Studio tab's own mechanism turned out to already be generic underneath: a webview panel that follows a `{dir, target, launchedAt}` run, bound and rebound by reading whichever `.8bs-last-<target>.json` the CLI writes. Only the fixed strings around it were Studio- and cx16-specific — the panel's own title and subtitle, and a mouse-status line that assumed every `--web` target has one to report on. Both are now per-target: `TARGET_LABELS` in `studioView.cjs` names each machine and, for the PET, VIC-20 and C64's own wasm builds, says so honestly ("wasm build," never "emulator") and tells the page there is no mouse to show a status line for.

**Preview On…** reuses that same mechanism through a second, generic command (`previewOn` → `previewTab.show`), picking a project and target the same way every other command-palette action here does (a quick pick only when there is more than one of either), running it with `--web`, and following the same run in its own tab — Studio's tab is untouched and keeps its own command.
