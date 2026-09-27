---
"8bitscript-lang": minor
---

The Preview/Studio tab now offers "Open in \<emulator\>" — xpet, x16emu, whichever the target's own catalog names — when `8bs doctor` reports that machine's real emulator installed and working. It launches the native run as a second, independent task (`web: false`, exactly the "Run in emulator" sliver-menu item's own path) alongside the wasm preview, never in place of it: closing the preview does not touch it, and it does not touch the preview.

The button's own visibility and label are a fact about the host, not about the current preview's phase — it stays offered even while the wasm build is still "being built" or after the run has stopped, since whether the real machine is there to open never depended on that.

`emulatorIsReady`, previously local to the side bar's own launcher, moved to `projects.cjs` so `studioView.cjs` could read the same Doctor verdict without a circular require back through `launcherView.cjs` (which already depends on `runner.cjs`, which now would have needed `launcherView.cjs`'s help). `launcherView.cjs` re-exports it unchanged, so nothing else moves.
