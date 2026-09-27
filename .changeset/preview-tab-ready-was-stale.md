---
"8bitscript-lang": patch
---

The Preview/Studio tab's status line could stick on "being built…" over an already-rendered screen, for a build fast enough — hello-world's PET, for instance — to finish before the extension's 1-second live poll had ticked even once.

The page asks for its state the moment its own script runs (`postMessage({type: 'ready'})`), which the host answered by echoing whatever `phase` its *last* `refresh()` call had computed — usually 'building', cached from the very first read, taken before the run had written anything at all. Nothing re-read the last-run file in between: the live poll is the only thing that ever does, and it only ticks once a second. A build that lands inside that window left the page's own ready handshake asking a question the host answered from a memory that was already out of date.

`ready` now calls `refresh()` instead of `post()`, so it re-reads the file first and always answers with this run's actual, current phase — never waiting on the next poll tick to catch up with a build that already finished.
