# @8bitscript/i18n

What the build's locale is like, decided at compile time — the same on
every target, VIC-20, C64, PET, C128, Atari 8-bit, NES, Commander X16,
MEGA65, and web. Two import paths: the facts, and a number printed with
them.

```bash
pnpm add @8bitscript/i18n
```

```
import { Locale } from "@8bitscript/i18n";          // the facts: two ASCII codes
import { number } from "@8bitscript/i18n/number";   // a grouped number, through @8bitscript/text

text.putChar(cell, Locale.DECIMAL);   // '.' — or ',' in a German build
number.print(cell, score, 6);         // "12,345" — or "12.345"
```

| Name | What it is |
| --- | --- |
| `Locale.DECIMAL` | The character between a number's whole and fractional parts, as the ASCII code `text.putChar` takes: `.` (46), or `,` (44) |
| `Locale.GROUP` | The character between groups of three digits: `,` (44), `.` (46), or a space (32) |
| `number.print(cell, value, width)` | `value` as decimal digits with `Locale.GROUP` every three from the right, right-aligned in `width` cells from `cell`, blank ahead of it. Six cells hold the widest `usmallint`, `65,535`; a narrower field prints the whole number from `cell` rather than cutting it |

## How a locale gets in

A locale is a build input, never a run-time one: `8bs build --locale de`,
a target's `locale`, or a `release` entry's (see
[Project config](../../docs/config.md#one-binary-per-locale)). This
package is one file per locale — `src/index.8bs` for a build that names
none, `index.de.8bs`, `index.fr.8bs`, `index.it.8bs`, `index.nl.8bs`,
`index.pt-br.8bs` beside it — and the compiler's resolver picks the file
by the same twin rule that takes a program's own `strings.de.8bs` over its
`strings.8bs`. Nothing in a program names a locale; nothing is looked up
while it runs; a program that reads neither name links none of this.

A locale with no file here silently reads the plain one — `--locale sv`
gets `.` and `,`. Add a twin (five lines; cite the CLDR entry, as each of
the shipped ones does) rather than branch on `#locale("sv")` in a program.
Spanish is deliberately not shipped yet: CLDR gives `es` a
`minimumGroupingDigits` of 2, so a four-digit number is written `1234`
and only `12.345` is grouped — a rule `number.print` does not express,
and a twin that said `.` alone would print `1.234`. Check the key in
CLDR's `numbers.json` for `es` before adding it.

## What is here, and what is not

The two facts are the ones a program on a character grid can act on.
Every value is a literal in the portable character set — `,` `.` and the
space are on every machine, including the NES's own font — so a build
never reaches for a glyph its target cannot draw. A read of one folds to
the literal: a PET, VIC-20 or C64 program that writes `Locale.GROUP` is
byte-identical to one that writes `44` (a test builds both and compares
the images). Nothing here is a
string: a program's strings are its own, in a `strings.8bs` and that
file's locale twins, where the compiler can see their lengths. Nothing
here names an accented letter or a currency sign, because no target can
show one; a language written in them is transliterated in the program's
strings file (`DRUECKEN`), the way a typewriter without the keys spelled
it, and that is a decision the program's author makes line by line.

`number.print` is code — the place-value loop every machine's
`text.printNumber` uses to find digits without a divide, plus the
separator — and lives at its own subpath so that a program printing a
zero-padded HUD field (`text.printNumber`, or a `${score:5}` template)
carries none of it. What it costs, measured 2026-09-17 as one number
printed this way instead of with `text.printNumber`, in a program that
owns its machine: +209 bytes and +11 of RAM on the PET, +202 and +11 on
the unexpanded VIC-20, +194 and +9 on the C64. The two are for different
numbers: `printNumber` is the counter that must never shift columns,
this is the total the player reads.

Tests: `pnpm --filter @8bitscript/i18n test` — resolution per locale on
every machine, a clean link on all nine with and without a locale, the
PET and VIC-20 images built for real (the fact byte-identical to its
literal; `number.print`'s frame inside their zero page), and
`number.print` built and run for the web, its cells read back, in
English and in German.
