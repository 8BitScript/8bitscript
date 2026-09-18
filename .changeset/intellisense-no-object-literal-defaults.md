---
"@8bitscript/compiler": patch
---

Replaced the two `{ machine: null, why: null }` object-literal default parameters in the IntelliSense module (`hoverAt`, `completionsAt`) with one shared frozen constant, clearing two SonarCloud code smells (S7737, "Objects should not be used as default parameters"). No behavior change.
