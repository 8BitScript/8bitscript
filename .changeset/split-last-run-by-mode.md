---
"@8bitscript/cli": patch
---

Fixed the Running machines tree showing two identical rows when a real machine's own wasm-backend preview and its native run (e.g. the Preview tab's "Open in emulator" button) were running at once for the same project and target — reported live as "two hello-8bx's running... duplicating the data into both entries" when only one was actually the VIC-20 preview.

`8bs run`/`8bs build --web` now write a real machine's own wasm-backend build to a second file (`.8bs-last-<target>-web.json`), distinct from that same machine's native run's `.8bs-last-<target>.json` — the two runs no longer race to overwrite one file that both readers shared. The synthetic `web` target, which never has a native counterpart, keeps its one plain file either way.
