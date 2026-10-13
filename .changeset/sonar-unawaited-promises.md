---
"8bitscript-lang": patch
"@8bitscript/language-server": patch
---

Two event handlers that call an async function mark the promise as deliberately not awaited (`void`), as the rest of the code does — a lint finding, no change in behaviour.
