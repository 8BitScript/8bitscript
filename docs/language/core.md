---
title: "Core language — .8bs"
nav_order: 2
---

# Core language — .8bs

The language underneath everything, including every `.8bx` file: types, storage, arrays, strings, functions, imports, hardware access, and compile-time folding.

## §1.1 Declare a range-checked integer

Eight primitive integer types, named MySQL-style so the width reads without abbreviation knowledge; the short systems spelling (`u8`, `i16`, …) works too — both resolve to the same type, never two types that happen to agree.

| Canonical | Alias | Signed | Bytes | Range |
| --- | --- | --- | --- | --- |
| `tinyint` | `i8` | yes | 1 | −128 … 127 |
| `utinyint` | `u8` | no | 1 | 0 … 255 |
| `smallint` | `i16` | yes | 2 | −32768 … 32767 |
| `usmallint` | `u16` | no | 2 | 0 … 65535 |
| `mediumint` | `i24` | yes | 4* | −8,388,608 … 8,388,607 |
| `umediumint` | `u24` | no | 4* | 0 … 16,777,215 |
| `int` | `i32` | yes | 4 | −2.1B … 2.1B |
| `uint` | `u32` | no | 4 | 0 … 4.29B |

* 24-bit values widen to 4 bytes in memory: neither backend has a native 3-byte width.

Plus `bool` (1 byte) and `string` (a 2-byte pointer on a 6502, 4-byte `usize` on the web — not RAM a program's own budget counts). A literal that doesn't fit is a build error, not a silent wrap:

*the range check, as it actually reports*

```8bs
let score: u8 = 300;
```

```text
error 8BS1021: 300 does not fit in u8 (0..255)
```

## §1.2 Choose where a global lives

A global's section follows directly from how you declare it — nothing is left to a runtime initializer:

| Declaration | Section |
| --- | --- |
| `const`, given a value | `.rodata` — program data, read-only |
| `let`, given a value | `.data` — initialized RAM |
| `let`, no initializer | `.noinit` — RAM, contents undefined at start |
| `@address(N) let` | overlays hardware directly at `N` |

Old-BASIC's `POKE` becomes a typed call rather than a magic number pair:

| BASIC | 8BitScript |
| --- | --- |
| `POKE 36879,27` | `memory.write(36879, 27);` |

## §1.3 Declare and pass an array

Arrays are laid out at compile time — no heap, no `malloc`. Passed to a function by name, it's the address, nothing copied, and `t.length` is a compile-time constant inside the callee:

```8bs
let board: array<utinyint, 16>;

function sumBoard(t: array<utinyint, 16>): utinyint {
    let total: utinyint = 0;
    for (let i: utinyint = 0; i < t.length; i++) {
        total = total + t[i];
    }
    return total;
}
```

Local arrays and pointers are not part of the compiled subset yet — a construct the compiler can't lower is refused by name, never silently miscompiled (see [§8.1](not-yet.md#81-what-doesnt-exist-yet-dont-reach-for-these)).

## §1.4 Work with strings and templates

String literals as `string` parameters, `string` consts, fixed-capacity `string<N>` variables, and templates — all laid out at compile time. A format specifier after a colon pads/aligns a number inside a template:

```8bs
text.print(0, `TICK ${ticks:1}`);
```

## §1.5 Functions and control flow

Functions with parameters and return values, arithmetic, `if`/`while`/`for` — the ordinary compiled subset. `const`s are inlined at compile time wherever they're used.

## §1.6 Import across files and namespaces

The linker resolves imports across modules, whether the target is a bare package (`@8bitscript/screen`), a relative `.8bs`/`.8bx` file, or a package subpath (`@8bitscript/ui/menubar`, exported via that package's own `"8bitscript"` field). Namespaces group related declarations under one imported name.

## §1.7 Override one file per machine (twin files)

Beside `tile.8bs`, a file named `tile.pet.8bs` is used only when building for the PET; every other machine keeps the base file. The resolver's twin rule applies identically to `.8bx` — `App.8bx` becomes `App.pet.8bx` on the PET without anything else changing.

## §1.8 Drop into assembly and raw memory

`asm6502 { … }` blocks, `@address` decorators, and `memory.read`/`memory.write` are language features, not bolted-on escape hatches — available inline wherever a program genuinely needs the hardware underneath a portable API. Not inside `.8bx`, though — see [§2.7](composition.md#27-the-purity-rule-whats-refused-and-linted-in-8bx).

An `asm6502` operand may name the function's own parameters and locals: each is its zero-page slot, so a block can hand a native routine what the function was given —

```8bs
function print(cell: usmallint, s: string): void {
    asm6502 {
        lda cell        ; the parameter's low byte
        ldx cell+1      ; and its high byte, the offset folded in
        ldy #0
        lda (s),y       ; through a string parameter's pointer: its length
        jsr __8bs_c64_text_print
    }
}
```

A name the frame does not bind is a linker label, as before (`jsr __8bs_c64_raster_install`). A frame slot is data, so `jsr s`, `jmp (s)` or a branch to one is refused. Globals are not reachable this way — they are link-renamed, and a never-assigned one may already have been folded into its value; map hardware with `@address` instead. A function whose block names a parameter still receives it: the optimizer counts a name written in the block's text as a read.

## §1.9 Branch on the machine at compile time

`#fact(...)` asks a true/false question about the machine being built for — folded before the toolchain runs, so a guarded branch that can't be true on this target disappears entirely rather than shipping dead weight:

```8bs
const HAS_RASTER: bool = #fact(video.raster);
```

`#system()` compares the machine itself, both sides resolved at compile time, so a program branches on the machine without a per-machine file:

```8bs
if (#system() == System.C64) { /* … */ }
```

Common facts already read this way: `video.raster`, `input.keyboard`, `input.joysticks`, `input.pads`, `input.mouse`. An unknown fact name is a build error (`8BS1037`), not a silent `false`.

## §1.10 Print your own version

`#package("version")` is the `version` field of the nearest `package.json` above the file, as a string literal folded at compile time — so a title screen prints the version the package was published as, and nobody bumps a const by hand:

```8bs
const VERSION: string = #package("version");

export function main(): void {
    text.print(0, VERSION);          // "0.6.0", whatever package.json says
    text.print(40, #package("name")); // the other readable field
}
```

Once folded it *is* the literal — the same bytes as writing `"0.6.0"`, and the same checks: a name outside the portable character set is refused where it would be printed (`8BS1026`). The readable fields are `"version"` and `"name"`; any other field, or anything but one field name in quotes, is `8BS1041`. No `package.json` above the file, one that does not parse, or one without the field is `8BS1042`, naming the file. `8bs check` and the editor resolve it from the file exactly as a build does, so what they show is what the build prints. Nearest-above-the-file, not the directory the build runs from: a module inside a package reads that package's own version.

A string is not a number field, so a version cannot go inside a template's `${…}`; print it as its own argument. Its `.length` is a run-time value today, not a `const` initializer — right-align it with a field width you choose, or count on it being short.
