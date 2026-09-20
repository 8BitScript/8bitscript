---
"@8bitscript/sprites": patch
"@8bitscript/timeline": patch
---

`@8bitscript/sprites` and `@8bitscript/timeline` join the fixed version group in `.changeset/config.json`, so every package moves to the same version together. Both were new in 0.18.0 and were left out of the group; the 0.18.0 changeset happened to name them, so they matched, and the next version bump that did not — 0.19.0 — left them at 0.18.1 and 0.18.0, which `scripts/release.mjs` refused before publishing anything ("sprites is 0.18.1, expected 0.19.0"). 0.19.0 was never published; this release is the first with the baseline.
