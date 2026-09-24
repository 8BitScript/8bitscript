---
title: "The language, by task"
nav_order: 1
---

# The language, by task

Two languages share one pipeline, and two more join as their own front ends. `.8bs` is the core language — types, functions, hardware access, nothing hidden. `.8bx` adds declarative composition on top: elements and components that elaborate to the same calls you would write by hand, at the same cost. `.8bg` and `.8ba` declare a sprite or a song; they are not 8BitScript. This manual documents what compiles today, at compiler 0.11.0; anything still proposed is labelled *planned* and kept in one place ([Not yet available](not-yet.md)).

Look a task up, not a chapter: every entry is one thing you can do. Each carries a `§` number for citing it. Code samples are real — taken from the compiler's own test suite, the shipped examples, or 2048 — not invented for this page. The design behind `.8bx` is the [8BX specification](../spec/8bx.md); what the compiler has of it, and what it does not yet, is [8BX: composition for 8BitScript](../project/8bx.md).

## The manual

- [Core language — .8bs](core.md)
- [Composition — .8bx](composition.md)
- [The .8bs ↔ .8bx boundary](boundary.md)
- [Project & CLI](project.md)
- [Editor & diagnostics](editor.md)
- [Standard packages](packages.md)
- [Worked examples](examples.md)
- [Not yet available](not-yet.md)

## §0.1 What 8bs and 8bx are

`.8bs` is 8BitScript's core language: a statically compiled, TypeScript-flavored language for the 6502 family and the web, with no garbage collector, no boxing, and no hidden allocation. Range-checked fixed-width integers, arrays and strings laid out at compile time, and `asm6502` as a first-class construct rather than an escape hatch.

`.8bx` is a second source kind that shares the exact same pipeline (lexer → parser → fold → binder → checker → linker → backend) but additionally understands element syntax and `component` declarations — composition, not a UI framework. A component is a function; an element is a call to it. There is no virtual DOM, no retained tree, no runtime object graph: everything a `.8bx` file describes is elaborated away before any backend sees it, so a declarative `<Board />` costs exactly what calling `board()` by hand would.

| Extension | Grammar | Can be a program entry? |
| --- | --- | --- |
| `.8bs` | Core language | Yes — the only kind that can be |
| `.8bx` | Core language + elements + `component` | No — refused by name ([§3.1](boundary.md#31-call-a-component-from-8bs)) |
| `.8bg` | Sprite declarations (not 8BitScript) | No — a program imports it |
| `.8ba` | Instrument / sample / song (not 8BitScript) | No — a program imports it |

## §0.2 Hello world, both ways

Without composition, a program is one `.8bs` file:

*src/hello-world.8bs*

```8bs
import { screen } from "@8bitscript/screen";
import { text } from "@8bitscript/text";

export function main(): void {
    screen.blank();
    text.print(0, "Hello World!");
    text.releaseCursor();
}
```

With composition, the greeting becomes a component in its own `.8bx` file, and the program imports and calls it — the two builds are byte-identical on the PET:

*src/Hello.8bx*

```8bx
import { text } from "@8bitscript/text";

export component Hello() {
    text.print(0, "Hello World!");
}
```

*src/hello-bx.8bs — the program*

```8bs
import { screen } from "@8bitscript/screen";
import { Hello } from "./Hello.8bx";
import { text } from "@8bitscript/text";

export function main(): void {
    screen.blank();
    Hello();
    text.releaseCursor();
}
```

See [§7.1](examples.md#71-hello-bx-end-to-end) for the measured byte count and [§3.1](boundary.md#31-call-a-component-from-8bs) for why `Hello();` is exactly `<Hello />` spelled the way `.8bs` can spell it.
