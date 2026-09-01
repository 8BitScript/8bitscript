# hello-vic

The first consumer application for the 8BitScript toolchain.

This is not a test fixture. It depends on `@8bitscript/cli`,
`@8bitscript/core`, and `@8bitscript/vic20` with `workspace:*`, so pnpm links
them out of `packages/` and the example resolves them through `node_modules`
exactly as a project installed from the registry would. Nothing here is special
-cased by the build.

## Status

This example does not build yet — deliberately. It is written against the
intended standard library (`screen`, `input`, `vic`), whose namespace surface
does not exist. The linker now loads and resolves both imports, so the build
fails on what is genuinely missing — the names are not exported, and calls do
not lower:

```
error 8BS2005: 'screen' is not exported by '@8bitscript/core'
error 8BS3001: a call through member access is not compilable yet
```

That is the exhaustive-with-error rule working: the compiler refuses to build a
program missing half its meaning rather than emitting something silently wrong.
For programs that *do* compile and run today, see `examples/counter` (both
targets) and `examples/border` (VIC-20 and C64, visibly — one source file
that imports its colour API from `@8bitscript/machine`, which resolves to
the target package for whichever machine is being built).

## The intended loop

Working on the toolchain looks like this:

```
edit the compiler  ->  edit src/main.8bs  ->  pnpm --filter hello-vic run:vic20  ->  VICE opens
```

No publishing step, no linking by hand, no submodules. See
[the package model](../../docs/packages.md) for how resolution works and how
this scales to third-party packages.
