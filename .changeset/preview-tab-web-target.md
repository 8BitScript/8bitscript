---
"8bitscript-lang": patch
---

The Preview tab follows a run of the synthetic `web` target. It looked for the tab's run by the `web` flag, which a `web`-target run never carries (that flag keys a real machine's `-web` last-run file), so the tab saw no run and said "Studio is not running" under Studio's own title. The tab now finds, stops and replaces its run by `runtime: 'editor'`, which every tab run carries; `web` has its own labels ("Web", no mouse line); and a bound run on any target without labels is called by that target's name, so only Studio's own tab ever says "Studio".
