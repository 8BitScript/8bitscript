---
"8bitscript-lang": patch
---

The launcher's System dropdown no longer snaps back to PET when a program has no named systems. An empty named system is stored as `''`, and `??` was keeping that blank instead of the machine id, so the dropdown fell through to its first option.
