---
"@8bitscript/compiler": minor
"@8bitscript/cli": minor
"8bitscript-lang": minor
---

Native builds can now retain source provenance through lowering, assembly, and branch relaxation, and `8bs build --debug` writes a human-readable `.lst` listing and a versioned `.8bs.debug.json` debug map alongside the artifact. The VS Code extension adds "8BitScript: View Generated Assembly", which opens the generated instructions for the file beside the editor and navigates back to source on selection. Off by default; release builds are unaffected.
