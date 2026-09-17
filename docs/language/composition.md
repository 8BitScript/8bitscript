---
title: "Composition — .8bx"
nav_order: 3
---

# Composition — .8bx

Everything below elaborates to the core AST in [§1](core.md) before any backend runs — there is no second grammar downstream of the checker, and no construct here costs more than the calls it expands to.

## §2.1 Write an element and a fragment

An element is `<Name prop={expr} />` or, with children, `<Name>…</Name>`. A fragment (`<>…</>`) groups children with no wrapper of its own — 2048's `Screen` component returns one around a conditional ([§2.4](#24-compose-conditionally), [§7.2](examples.md#72-2048s-screen8bx-byte-for-byte)):

```8bx
export component Screen() {
    return (<>{started ? <Board /> : <Title />}</>);
}
```

The lexer gives element syntax its own tokens (tag / children / expression modes on a stack), so `<` only opens a tag where no value precedes it — the ordinary less-than operator is unaffected everywhere else, in both `.8bs` and `.8bx`.

## §2.2 Declare a component with props and defaults

A component is declared like a function; its parameter list is its props, and a parameter can carry a default. A bare attribute (no `={…}`) means `true`:

*real compiler test — props, defaults, bare attributes*

```8bx
component Box(x: utinyint, y: utinyint, wide: bool = false, tall: bool = false) {
    if (wide) { hits = hits + x; }
    if (tall) { hits = hits + y; }
}

export function main(): void { <Box tall y={4} x={2} />; }
// elaborates to: Box(2, 4, false, true)
```

Props are matched by name at the call site, then passed in declaration order — attribute order in the tag doesn't matter. A component without `export` is only visible inside its own module.

## §2.3 Accept children with <slot />

A component with `<slot />` in its body is elaborated as two functions, one on either side of the slot — children run once, in place, between them. `@8bitscript/ui`'s menu bar is the shipped example, byte-identical to the hand-written begin/item/item/end calls:

*packages/ui/src/menubar.8bx*

```8bx
import { menubar } from "./menubar.8bs";

export component MenuBar(row: utinyint, width: usmallint) {
    menubar.begin(row, width);
    <slot />;
    menubar.end();
}

export component MenuItem(label: string) {
    menubar.item(label);
}
```

Used as:

```8bx
<MenuBar row={0} width={40}>
    <MenuItem label="FILE" />
    <MenuItem label="EDIT" />
</MenuBar>
```

One slot per component today — see [§8.1](not-yet.md#81-what-doesnt-exist-yet-dont-reach-for-these) for named slots.

## §2.4 Compose conditionally

`{cond ? <A /> : <B />}` elaborates to an if/else with an arm each; `{cond && <A />}` to an if with one arm. When the condition is a compile-time fact ([§1.9](core.md#19-branch-on-the-machine-at-compile-time)), the arm that can't run is dropped — component and all — at compile time: a title-screen wobble guarded by `#fact(video.raster)` costs nothing on a machine with no raster hardware, rather than shipping and no-op'ing at run time.

*real compiler test — both forms, verified as one `if` each*

```8bx
let paused: bool = false;

export function main(): void {
    paused = true;
    <Box>{paused ? <A /> : <B />}{paused && <A />}</Box>;
}
```

## §2.5 Give a component state

`state name: Type = initial;` at the top of a component body is storage per *static instance* — every element (or `.8bs` call site) that instantiates the component gets its own copy, laid out at compile time as a plain global, not allocated at run time. Two elements of the same component are two instances with two states; the two halves of a slotted component (either side of `<slot />`) share one instance's state. `8bs build --size` lists every instance and the bytes its state holds.

*real compiler test*

```8bx
component Counter(step: utinyint) {
    state count: utinyint = 0;
    // …
}
```

State is not automatically reactive — nothing re-renders when it changes; a component reads its own state exactly like any other variable, whenever its code runs. A duplicated, untyped, or out-of-place `state` is `8BS2022`; the keyword is only special inside a component body — `state` is just a name anywhere in `.8bs`.

## §2.6 Give a component methods

A function declared at the top of a component body is a method: instanced with the component's own state, callable by its own name from elsewhere in the body. A method sees state, not props — pass a prop in as an ordinary argument if a method needs it:

*real compiler test — packages/compiler/test/bx-methods.test.mjs*

```8bx
component Player() {
    state health: utinyint = 100;
    function damage(amount: utinyint): void { health = health - amount; }
    function heal(): void { damage(0); health = health + 1; }
}
```

A method whose own parameter or local shadows a same-named prop is fine; a method that reaches for a prop directly by name is `8BS2025` with a message naming which prop and that a method sees state, not props.

## §2.7 The purity rule — what's refused and linted in .8bx

`.8bs` is code, `.8bx` is composition — enforced as one hard rule plus one default-on lint, not a second grammar:

| Level | Rule | Code |
| --- | --- | --- |
| **Hard** | `asm6502` is refused inside a `.8bx` file. Machine code lives in `.8bs` and is imported. | 8BS2020 |
| Lint (on by default) | A top-level function whose body composes nothing (no element expression), or a top-level `let`, in `.8bx` — move it to `.8bs` and import it. Component methods and `state` are exempt. | 8BS2021 |

Turn the lint off per project with `bx: { strict: false }` in `8bitscript.config.ts` ([§4.1](project.md#41-write-a-project-config)) — the hard rule stays either way. Expressions inside `{…}` are ordinary 8BitScript in both file kinds; it's top-level *declarations* the lint is about.
