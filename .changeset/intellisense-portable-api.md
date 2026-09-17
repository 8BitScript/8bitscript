---
"@8bitscript/language-server": patch
---

Hover, completion and Go to Definition on a hardware API (`@8bitscript/screen`,
`text`, `input`, `raster`) show the API every machine agrees on, read from all
nine machine modules at once, instead of one machine's implementation with
"shown as implemented for the pet target — another target's version may
differ" under it. What differs between machines is said, and only when it
does: which machines have a member the others lack (and that yours is one of
them, when the file is a machine's twin or the project has one target), whose
signature disagrees with the portable one, and whose doc is being shown when
each machine documents a member in its own words. Completion annotates a
machine-specific member with its machines; Go to Definition opens the module
for your file's or project's machine, else the first that has the member. A
new compiler test fails the workspace when two machines give a portable member
different signatures (one known case is recorded: `raster.at`'s `line` width).
