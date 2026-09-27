---
"8bitscript-lang": patch
---

"Open in emulator" could knock a perfectly running Preview tab back to "being built…". Its native run shares `dist/.8bs-last-<target>.json` with the wasm preview it sits alongside — the CLI writes that file per *target*, not per build mode — and the native run's own compile step overwrites it with a fresh, no-url report the instant it starts. The Preview tab's `refresh()` took that at face value: no URL in the latest write meant "not running yet", even though the wasm task it was actually following had never stopped and was still rendering exactly what it always had.

A URL this tab already has framed now keeps counting as running through an unrelated write to that shared file. Only an actual stop of this tab's own task, or a genuinely fresh *different* URL (a real rebuild, which always stops this task first), moves it off what it is already showing.
