# @8bitscript/i18n

What the build's locale is like, decided at compile time — the same on
every target, VIC-20, C64, PET, C128, Atari 8-bit, NES, Commander X16,
MEGA65, and web. Four import paths: the facts, a number printed with
them, a line padded to a layout width, and the project's message catalog.

```bash
pnpm add @8bitscript/i18n
```

```
import { Locale, i18n } from "@8bitscript/i18n";
import { number } from "@8bitscript/i18n/number";
import { messages } from "@8bitscript/i18n/messages";
import { Game, Prompt } from "@8bitscript/i18n/catalog";
import { Input } from "@8bitscript/input";

text.putChar(cell, Locale.DECIMAL);   // '.' — or ',' in a German build
number.print(cell, score, 6);         // "12,345" — or "12.345"
text.print(cell, i18n.format(Prompt.START, { control: Input.CONFIRM_LABEL }));
messages.printLine(cell, Status.MOVE, WIDTH);
```

| Name | What it is |
| --- | --- |
| `Locale.DECIMAL` | The character between a number's whole and fractional parts, as the ASCII code `text.putChar` takes: `.` (46), or `,` (44) |
| `Locale.GROUP` | The character between groups of three digits: `,` (44), `.` (46), or a space (32) |
| `i18n.format(template, { name: value })` | A catalog string with `{name}` slots filled. Params are string consts or literals; the call folds to a literal, and `.length` folds with it |
| `number.print(cell, value, width)` | `value` as decimal digits with `Locale.GROUP` every three from the right, right-aligned in `width` cells from `cell`, blank ahead of it. Six cells hold the widest `usmallint`, `65,535`; a narrower field prints the whole number from `cell` rather than cutting it |
| `messages.printLine(cell, line, width)` | `line` at `cell`, then spaces through `width` cells — when a line's text changes width but its slot on screen does not |
| `messages.clearLine(cell, width)` | `width` spaces from `cell` |

## How a locale gets in

A locale is a build input, never a run-time one: `8bs build --locale de`,
a target's `locale`, or a `release` entry's (see
[Project config](../../docs/config.md#one-binary-per-locale)). This
package's facts are one file per locale — `src/index.8bs` for a build that
names none, `index.de.8bs`, `index.fr.8bs`, `index.it.8bs`, `index.nl.8bs`,
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

## Message catalogs

Project words live in `src/i18n/<locale>.8bs` — exported namespaces of
string consts, imported as `@8bitscript/i18n/catalog`. The compiler
selects one locale, fills missing keys from `i18n.fallbackLocale`, checks
that every locale exports the same names and `{placeholder}` sets, and
transliterates Latin extras (`Ü` → `UE`, `ß` → `SS`) into the portable
character set. `charset: 'strict'` refuses the extras instead. Length and
centring use the mapped columns: `Ü` is two cells.

```
export namespace Prompt {
    const START: string = "PRESS {control}";
    const START_EITHER: string = "PRESS {control} OR {other}";
}
```

Control names come from `@8bitscript/input` (`Input.CONFIRM_LABEL`).
Padding widths stay in the layout. Number grouping stays `Locale.*` and
`./number`. One resolved locale, one merged catalog, no other language
in the binary.

A project without an `i18n` block and without `src/i18n` is unchanged:
locale stays optional and no catalog is loaded.

## What is here, and what is not

The two facts are the ones a program on a character grid can act on.
Every value is a literal in the portable character set — `,` `.` and the
space are on every machine, including the NES's own font — so a build
never reaches for a glyph its target cannot draw. A read of one folds to
the literal: a PET, VIC-20 or C64 program that writes `Locale.GROUP` is
byte-identical to one that writes `44` (a test builds both and compares
the images).

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
