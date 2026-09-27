---
"8bitscript-lang": minor
---

Run is a split button now, folding the System dropdown into its own sliver — mirroring the split button Open Studio already had.

Run's primary half still runs the project, defaulting to a machine's own --web build where that already works (the PET today), exactly as the previous change made it. The chevron on its right edge opens a menu with two kinds of choice, in order: "Run in emulator" first — an explicit override forcing the native path for whichever system is currently selected, for the times the wasm build isn't what's wanted — then a divider, then the same grouped system list the removed dropdown showed (this clone's named systems, then the bare machines), picking one exactly the way the dropdown's own change handler did. `web` gets no such entry: `8bs run web` never meant anything but the browser build, so there is nothing to override.

The System dropdown is gone from Quick Launch entirely; Run's own sub-label now says which system it will run on and, when that means a --web build, adds "wasm" so the mode is never a guess. `WEB_PREVIEW_READY` (which targets get the web-by-default treatment) moved from runner.cjs to projects.cjs, since the panel now needs to read the same list runner.cjs decides against, and a second copy of it would have been the one way the two could disagree.
