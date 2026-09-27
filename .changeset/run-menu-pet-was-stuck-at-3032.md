---
"8bitscript-lang": patch
---

Picking a bare machine from Run's sliver menu now clears any hardware profile stuck to it from an earlier pick, instead of leaving it there forever.

`applySystem` (choosing one of a project's *named* systems) sets a hardware profile alongside the machine and the region, by design — that is the whole point of a named system. But picking a bare machine afterwards never undid it: `getEffectiveHardware` prefers any stored selection over a project's own config-declared default unconditionally, so a profile set once — by a named system, or by whatever the System dropdown wrote before it folded into Run's sliver — stayed pinned to that machine across every later project and config change. This is exactly how a workspace that had picked a 3032 PET weeks ago kept building a 3032 PET after `hello-world`'s `8bitscript.config.ts` was changed to default to a 2001: nothing about picking "pet" plain from the menu ever told the setting to let go.

Picking a bare machine now also clears the stored hardware for it, so it always means that machine's own stock — the project's config-declared default when it has one, the catalog's otherwise — never whichever profile happened to be sitting there from before.
