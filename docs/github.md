---
title: Building on GitHub
nav_order: 12
---

# Building on GitHub

8BitScript publishes a reusable GitHub Actions workflow that installs the
CLI, caches LLVM-MOS for 6502 targets, runs `8bs build` for each machine
you name, and can attach the binaries to a GitHub Release.

In your program's repository:

```yaml
# .github/workflows/release.yml
name: Release
on:
  release:
    types: [published]
jobs:
  compile:
    uses: 8BitScript/8bitscript/.github/workflows/compile.yml@v0.1.0
    with:
      targets: vic20,c64,pet,c128,atari8,nes,cx16,mega65,web
      cli-version: 0.1.0
      attach-release: true
```

Pin the reusable workflow to a tag (`@v0.1.0`), not `trunk`. The output
names already encode the machine, any fitted hardware, and the region:

```
dist/main-c64-ntsc.prg
dist/main-nes-ntsc.nes
dist/main-atari8-ntsc.xex
dist/main.wasm
dist/web/index.html
dist/web/program.wasm
```

`dist/web/` is the hostable wasm site — see [Hosting the web target](web.md).
A pull-request workflow can call the same file with `attach-release: false`
to fail the PR if a target no longer builds.

The job runs on Ubuntu with Node 26. It skips the LLVM-MOS download when
`targets` is exactly `web`.
