# hello-vic

The first consumer application for the 8BitScript toolchain.

This is not a test fixture. It depends on `@8bitscript/cli`,
`@8bitscript/core`, and `@8bitscript/vic20` with `workspace:*`, so pnpm links
them out of `packages/` and the example resolves them through `node_modules`
exactly as a project installed from the registry would. Nothing here is special
-cased by the build.

## Status

This example does not build yet — deliberately. It is written against the
intended standard library (`screen`, `input`, `vic`), which does not exist, so
`pnpm --filter hello-vic run build` fails with `8BS3001` diagnostics naming
each uncompilable construct:

```
error 8BS3001: imports are not compilable yet: there is no linker
error 8BS3001: a CallExpression expression is not compilable yet
```

That is the exhaustive-with-error rule working: the compiler refuses to build a
program missing half its meaning rather than emitting something silently wrong.
For programs that *do* compile and run today, see `examples/counter` (both
targets) and `examples/border` (VIC-20, visibly).

## The intended loop

Once the compiler exists, working on it looks like this:

```
edit the compiler  ->  edit src/main.8bs  ->  pnpm --filter hello-vic run:vic20  ->  VICE opens
```

No publishing step, no linking by hand, no submodules. See
[the package model](../../docs/packages.md) for how resolution works and how
this scales to third-party packages.
