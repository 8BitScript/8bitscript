---
title: "Migrating from the old syntax"
nav_order: 10
---

# Migrating from the old syntax

8BitScript moved from a TypeScript-style syntax to a Rust-style one in a single cut. There is no edition switch and no period in which both are accepted: from the cut release on, the compiler reads only the new syntax, and a file in the old syntax stops with an error that names `8bs migrate`. The language, the `.8bs` extension, the `8bs` command, and the `.8ba` and `.8bg` formats are unchanged. This is the only page of the manual that shows the old syntax.

`8bs migrate` ships in one release and is then deleted. Run it once on each project, commit the result, and move on.

## §10.1 Convert a project

```text
8bs migrate --check            # report what would change; writes nothing; exit 1 on any difference
8bs migrate                    # convert every .8bs and .8bx file under the project, in place
8bs migrate --embedded <file>… # programs held in JavaScript or TypeScript files (tests, generators)
8bs migrate --fences <md>…     # ```8bs fences in Markdown
8bs migrate --all [paths]      # all three over the same paths
8bs migrate --alias @lib       # an import alias head from your config (repeatable)
```

Every conversion is proved before it is kept: the new text is parsed by the new front end and must produce the same syntax tree as the old file. A file that does not pass is reported and left untouched, so a run never writes a file it could not check. Comments are kept, and one blank line between statements is kept. A literal inside a test file that cannot be taken is listed for you to convert by hand.

`8bs migrate` also renames a project's `8bitscript.config.8bs` to `8bitscript.config.ts`. The config is TypeScript and is not parsed as 8BitScript; the `.8bs` config name is no longer read, and a project that still has one is told so.

Running it on a file that is already in the new syntax is harmless: the file is reported as already converted.

## §10.2 What changed

| Old | New |
| --- | --- |
| `import { a, b as c } from "./geo.8bs";` | `use self::geo::{a, b as c};` |
| `from "../src/index.8bs"` | `use super::src::index::{…};` |
| `from "@8bitscript/c64/sprites"` | `use @8bitscript::c64::sprites::{…};` |
| `from "@lib/game/rules.8bs"` (config alias) | `use @lib::game::rules::{…};` |
| `from "./number-values.8bs"` (a name that is not a path) | `use "./number-values.8bs"::{…};` |
| `export function f(): void {}` | `pub fn f() {}` |
| `function f(a: u8): u8 { … }` | `fn f(a: u8) -> u8 { … }` |
| `export const`, `export let` | `pub const`, `pub let mut` |
| `namespace Color { … }`, `export namespace` | `mod Color { … }`, `pub mod` |
| `let x: u8 = 0;` (assigned later) | `let mut x: u8 = 0;` |
| `let x: u8 = 0;` (never assigned) | `let x: u8 = 0;` |
| `array<u8, 16>` | `[u8; 16]` |
| `@address($D020) let border: volatile<u8>;` | `#[address($D020)] let mut border: volatile<u8>;` |
| `@unroll for (…)` | `#[unroll] for …` |
| `memory.read(a)`, `port.x(…)`, `text.print(…)` | `memory::read(a)`, `port::x(…)`, `text::print(…)` |
| `if (c) { … } else if (d) { … }` | `if c { … } else if d { … }` |
| `while (c) { … }` | `while c { … }` |
| `while (true) { … }` | `loop { … }` |
| `for (let i: u8 = a; i < b; i++)` | `for i: u8 in a..b` (`<=` becomes `a..=b`) |
| `for (let i: u8 = 9; i > 0; i--)` | `for (let mut i: u8 = 9; i > 0; i -= 1) { … }` |
| `x++;`, `x--;` | `x += 1;`, `x -= 1;` |
| `c ? a : b` | `if c { a } else { b }` |
| `%1010` | `0b1010` |
| `'A'` | `"A"` |
| `export component Name(…) {…}` | `pub component Name(…) {…}` |
| a name that is now a keyword (`loop`, `in`, `mod`, `fn`, …) | `r#loop`, `r#in`, … |

Unchanged: type names (`u8` and `utinyint` are both legal), `volatile<T>`, `ptr<T>`, `string<N>`, `#fact(...)`, `#system()`, `asm6502 { … }`, backtick templates, `$FF` and `0xFF`, `~`, `.length`, `waitFrame()`, `const`, `return`, `break`, `continue`, comments, and the `.8bx` tag grammar.

## §10.3 What to know

- **`let` is immutable.** `let` binds once; `let mut` is the mutable form, and assigning to a plain `let` is error `8BS1031`. `8bs migrate` writes `let mut` exactly where the old program assigned the name, exported it, or named it inside an `asm6502` block, so a converted program means what it meant before.
- **`for` has two forms.** A counted loop whose body never assigns the counter becomes `for i in a..b`. Anything else keeps the C-style `for (…; …; …)`.
- **Paths use `::`.** A module path, a package path and a namespace member all read `a::b`. A value's field is still `x.length`.
- **A name that is not an identifier** (a file called `number-values.8bs`) keeps the string form: `use "./number-values.8bs"::{…};`.
- **Extension search.** A path import tries `.8bs`, `.8bx`, `.8bg` and `.8ba` in turn. Two files that match is error `8BS2217`.
- **Reserved words.** `enum`, `impl`, `struct`, `trait`, `static` and `type` are reserved and refused. There are no borrows, traits, crates or generics beyond the built-in type constructors.
- **Tests** are `#[test] fn` with `assert!`, `assert_eq!`, `assert_ne!` and `panic!`.
- **Not converted:** `8bitscript.config.ts` (TypeScript), `.8ba` and `.8bg` files.

The new syntax is described in [Core language](core.md) and [Composition](composition.md).
