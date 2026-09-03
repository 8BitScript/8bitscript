# vic20-first-program

The program from the VIC-20's own manual — the one nearly every VIC-20 owner
typed in first, and the one Commodore put on television:

```basic
10 PRINT "VIC 20"
20 GOTO 10
```

This is that program, compiled, not interpreted. There is no `PRINT` and no
`GOTO` in 8BitScript, so `src/main.8bs` is a translation, not a transliteration
— see the comment at the top of that file for what each line became and why
the famous scrolling look doesn't carry over (it needs dynamic screen
addressing, past what this example uses).

## Building and running

```
pnpm start        # NTSC
pnpm run start:pal  # PAL
```

Both open the compiled `.prg` in VICE. `pnpm build` / `pnpm run build:pal`
produce the `.prg` without launching the emulator.

## Status

VIC-20 only: it pokes the unexpanded machine's fixed screen-memory address
directly. See `examples/borders` for a program that targets all three
machines from one source file, and `examples/step1-main-loop` for the first
step of the Learn 8BitScript series.
