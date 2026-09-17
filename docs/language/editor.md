---
title: "Editor & diagnostics"
nav_order: 6
---

# Editor & diagnostics

## §5.1 Get IntelliSense in VS Code

The extension registers `.8bx` as its own language, sent to the same language server as `.8bs`. From the binder, the server now gives: hover on your own names, completion, and go-to-definition — inside `.8bx` specifically, completion after `<` offers your components, props complete as snippets, and `</` closes the currently open element.

## §5.2 Read a diagnostic code

Every diagnostic has a stable `8BSnnnn` code, independent of its message wording. The BX-specific ones, straight from the compiler's own registry:

| Code | Means |
| --- | --- |
| 8BS1039 | BX syntax error (lexer/parser) |
| 8BS2012 | Unknown component |
| 8BS2013 | Unknown prop |
| 8BS2014 | Duplicate prop |
| 8BS2015 | Missing required prop |
| 8BS2016 | Prop given the wrong type |
| 8BS2017 | Children given to a component with no slot |
| 8BS2018 | Component recursion |
| 8BS2019 | Invalid `<slot />` placement |
| 8BS2020 | `asm6502` inside `.8bx` — hard refusal ([§2.7](composition.md#27-the-purity-rule-whats-refused-and-linted-in-8bx)) |
| 8BS2021 | Ordinary top-level code in `.8bx` — lint, off via `bx.strict: false` ([§2.7](composition.md#27-the-purity-rule-whats-refused-and-linted-in-8bx)) |
| 8BS2022 | Invalid `state` — duplicated, untyped, out of place, or shadowed ([§2.5](composition.md#25-give-a-component-state)) |
| 8BS2023 | Invalid expression child |
| 8BS2024 | An element used where a value can't go |
| 8BS2025 | Invalid method — reaching for a prop by name instead of state ([§2.6](composition.md#26-give-a-component-methods)) |
