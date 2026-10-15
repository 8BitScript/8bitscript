---
"@8bitscript/studio": patch
"@8bitscript/examples": patch
---

Studio and the examples run from an npm install, not only from a checkout of the repository. Studio's package now ships its `8bitscript.config.8bs` (its `files` still named the old `8bs.config.ts`, so the editor never offered Studio to a project that had only installed `@8bitscript/cli`), and it reads the release targets from `@8bitscript/examples` instead of a path that only exists in the repository. The shared targets file is `shared-release-targets.mjs`, plain JavaScript: Node will not strip types from a file under `node_modules`, so every installed example's config was failing to load.
