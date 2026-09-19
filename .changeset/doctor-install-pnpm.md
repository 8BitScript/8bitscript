---
"@8bitscript/cli": patch
"8bitscript-lang": patch
---

`8bs doctor` offers to install pnpm (`npx get-pnpm`) and to run `8bs setup cx16` / `8bs setup mega65` for the source-built emulators. The editor finds pnpm where the installer actually puts it — including `~/Library/pnpm` on macOS — and offers **Run Doctor** instead of lecturing about `.zshrc`.
