---
"@8bitscript/cli": patch
---

Add `8bs build --dump-stages <dir>` (and the `EIGHTBS_DUMP_STAGES` environment variable), which writes each compiler stage's output as canonical text for comparing compiler implementations. A build without it is unchanged.
