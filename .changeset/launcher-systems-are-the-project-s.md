---
"8bitscript-lang": patch
---

The side bar's System dropdown offers the machines the selected program was set up for, and stops listing the rest.

It used to list every machine in the release and mark the ones outside the project un-runnable, so a project written for two machines still showed five. That is a list to read past rather than choose from — a machine a program was never written for is not a choice — and the ones that were only shown to be refused crowded out the named systems above them, which are the entries worth clicking.

The narrowing costs nothing to read: `readProject` already parses the config's `targets` block and already falls back to every release machine when a config names none, so a project that has not said what it targets sees exactly what it saw before, as does an editor with no project open. What changes is that saying so now has an effect.

Adding a machine is still a hand edit to the `targets` block. The System builder tab writes the *`systems`* block — named whole machines, `{ target, profile?, hardware?, region? }` — and `insertSystem` does not touch `targets`, so setting up a system for a machine the project does not target leaves it listed and un-runnable, exactly as it was before this change. Teaching Save to add the machine alongside the system is the obvious next step and is deliberately not taken here.

A project's named systems are unaffected and still lead the list; what no longer happens is a named system dragging its machine into the bare-machine list behind it.
