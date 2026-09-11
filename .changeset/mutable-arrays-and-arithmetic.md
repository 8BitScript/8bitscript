---
"@8bitscript/compiler": patch
---

Everything a real game needed: 2048 now builds, runs, and plays on both
0.2 targets, and the language features it forced are in.

- **Mutable arrays and `string<N>` buffers have storage on both
  backends.** On the PET a `let` array's bytes ride inside the program
  image — a loaded `.prg` is RAM, so the load is the initializer — and on
  the web they get a linear-memory home (zero by default, a data segment
  when initialized). `storeIndex` writes 1-byte elements on both;
  `stringCopy` and 2-byte const-array element reads land on the web.
- **The 6502 backend lowers `*`, `%`, `&`, `|`, `^`, and constant-amount
  `<<`/`>>`** — multiply via one shared shift-and-add routine (emitted,
  with its six zero-page cells, only when a runtime `*` survives the
  optimizer), `%` as the classic CMP/BCC/SBC subtraction loop, and the
  optimizer now folds all of these between constants and strength-reduces
  a constant multiplier (power of two, or two set bits over a ref) into
  shifts before any backend runs.
- **16-bit return values.** A 16-bit-returning function writes a fixed
  zero-page pair of its own; the call site copies it out immediately.
- **Zero-page frames.** Parameters, return slots, and locals now overlay
  by call depth (recursion-free by construction): two functions never
  live at once share the same bytes, and calls nested in a call's later
  arguments count as live extensions. A `waitFrame()` program — which
  owns the machine outright, interrupts off from its first store — now
  claims the whole $02-$FF budget; a program that returns to BASIC keeps
  the polite $8E-$FF one.
- **Two real codegen bugs fixed.** 16-bit comparisons read the Z flag off
  a CMP/SBC chain where only the carry is meaningful — `34 >= 100` came
  back "equal" and printNumber's digit loop subtracted forever; equality
  now compares byte-by-byte and orderings read only the carry. And the
  optimizer inlined no-parameter void calls whose bodies contain
  `return`, which then returned from the *caller* — 2048's spawnTile
  silently ended main() from inside resetGame(). A body with a return
  anywhere now stays a real call.
- **The linker types cross-module reads.** A ref to an imported global,
  an imported array's element read, and a call to an imported function
  all reach the backends with real types, so the 6502's 8-vs-16-bit
  split never meets a typeless node.
