---
"8bitscript-lang": patch
---

**The launcher is three bands, and only the middle one scrolls.** The head — the Project and System pickers, the one-line summary, and the run tiles for the selected program — never leaves the screen, however long the program list is; the tools (Studio, Doctor, Project details) are a fixed foot; the middle is one of two panes, **Programs** or **Running**, with the filter box above the list once a project has more than seven programs. A program row's own three small run buttons now show only when the row is pointed at, selected or focused (and stay lit while a run is live), so a long list reads as a list.

**The three runtimes are Preview, Browser and Emulate** (formerly Editor, Browser and Native), and each tile says under its name where it will open: the editor you are in (Cursor, VS Code, …), your default browser (read from the system's https handler on macOS, Windows and Linux, and left blank when it cannot be told), and the machine's emulator executable (`x64sc`, `xvic`, `x16emu`, …). Preview has a window icon. The messages that name the runtimes follow. Command ids and the `runtime` values in `tasks.json` (`editor`, `browser`, `native`) are unchanged, so nothing saved or bound stops working.
