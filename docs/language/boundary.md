---
title: "The .8bs ↔ .8bx boundary"
nav_order: 4
---

# The .8bs ↔ .8bx boundary

A program is always `.8bs`. This is the rule that decides how it ever reaches a component.

## §3.1 Call a component from .8bs

A component declared `component Player(x: utinyint, y: utinyint)` is visible to a `.8bs` module as an ordinary callable with that exact positional signature. A call from `.8bs` is an element instantiation at that call site, elaborated exactly as `<Player x={..} y={..} />` would be, checked by every rule in [§2.2](composition.md#22-declare-a-component-with-props-and-defaults):

```8bs
import { App } from "./App.8bx";
import { Player } from "./Player.8bx";

export function main(): void {
    App();            // elaborated here, exactly like <App />
    Player(20, 40);   // props are the positional arguments
}
```

An `.8bs` caller cannot pass children. There is no "required slot": a component that places `<slot />` is also kept as a plain function with the slot elided, and that is what the `.8bs` call form elaborates to — the children a `.8bx` element would have put there simply are not there (`packages/compiler/src/bx/elaborate.mjs`). Attribute-only affordances — boolean shorthand, string attributes — have no `.8bs` spelling; they're just the ordinary arguments (bare-attribute-true still applies as a default, [§2.2](composition.md#22-declare-a-component-with-props-and-defaults)).

## §3.2 What an .8bx file may export back to .8bs

Components (callable as in [§3.1](#31-call-a-component-from-8bs)), plus whatever the purity rule ([§2.7](composition.md#27-the-purity-rule-whats-refused-and-linted-in-8bx)) still allows at the top level of a `.8bx` module: `const`s and types at minimum.

## §3.3 What never crosses

A component's `state` and methods are not reachable from `.8bs` by name — they lower to generated `__bx_`-prefixed symbols, private to the instance. A program that needs to read or change a component's state does it through a method the component exposes as part of its call, or keeps that piece of state in `.8bs` and passes it in as a prop instead.
