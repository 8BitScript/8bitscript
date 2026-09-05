# hello-vic

The first consumer application for the 8BitScript toolchain.

This is not a test fixture. It depends on `@8bitscript/cli`,
`@8bitscript/text`, and `@8bitscript/vic20` with `workspace:*`, so pnpm links
them out of `packages/` and the example resolves them through `node_modules`
exactly as a project installed from the registry would. Nothing here is special
-cased by the build.

## Status

This example does not build yet — deliberately. It is written against the
intended standard library (`text` with an `x, y` `putChar`, `input`, `vic`),
two thirds of which do not exist: `@8bitscript/input` is not a package yet,
and `@8bitscript/vic20` exports its registers, not a `vic` namespace. The
linker loads and resolves the imports, so the build fails on what is
genuinely missing rather than on the resolution:

```
main.8bs:2:1
error 8BS2001: cannot find package '@8bitscript/input'. Is it installed?

main.8bs:3:10
error 8BS2005: 'vic' is not exported by '@8bitscript/vic20'

2 problem(s); not building.
```

(`@8bitscript/text` resolves and links — it is real, through
`@8bitscript/vic20/text` — though `text.putChar(x, 10, 65)` passes three
arguments to a function that takes two, which nothing checks until the
binder exists.)

That is the exhaustive-with-error rule working: the compiler refuses to build a
program missing half its meaning rather than emitting something silently wrong.
For programs that *do* compile and run today, see `examples/counter` (both
targets) and `examples/borders` (every target, visibly — one source file that imports
`@8bitscript/screen` and `@8bitscript/text`, each of which resolves to the
target package's own implementation for whichever machine is being built).

## The intended loop

Working on the toolchain looks like this:

```
edit the compiler  ->  edit src/main.8bs  ->  pnpm --filter hello-vic run:vic20  ->  VICE opens
```

No publishing step, no linking by hand, no submodules. See
[the package model](../../docs/packages.md) for how resolution works and how
this scales to third-party packages.
