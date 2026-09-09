---
title: Install from npm
nav_order: 1
---

# Install from npm

The toolchain is the `@8bitscript/cli` package on npm, versioned lockstep
with every other `@8bitscript/*` package. A project is an ordinary Node
project: you declare the CLI as a dev dependency and the capability packages
your program imports as dependencies.

```bash
pnpm add -D @8bitscript/cli
pnpm add @8bitscript/screen @8bitscript/text @8bitscript/input @8bitscript/system
```

`8bs` is then at `node_modules/.bin/8bs`. `pnpm exec 8bs doctor` reports
whether each emulator is installed; the web target needs only Node.

Pin the version you mean. The first public release is **0.1.0**:

```json
{
  "devDependencies": {
    "@8bitscript/cli": "0.1.0"
  },
  "dependencies": {
    "@8bitscript/screen": "0.1.0",
    "@8bitscript/text": "0.1.0",
    "@8bitscript/input": "0.1.0",
    "@8bitscript/system": "0.1.0"
  }
}
```

The CLI depends on the compiler, including both backends (`mos` and `wasm`
inside `@8bitscript/compiler`), so installing it is enough to name every
target. Until 0.2.0, `8bs build --target` refuses all of them: nothing
emits a `.prg`, `.xex`, `.nes`, `.rom`, or `.wasm`. Capability packages
stay direct dependencies because that is how
`import { text } from "@8bitscript/text"` resolves.

The [host toolchain](setup/host-toolchain.md) page still covers Node 26 and
pnpm 12. To compile on GitHub instead of locally, see
[Building on GitHub](github.md). To host the wasm build, see
[Hosting the web target](web.md).
