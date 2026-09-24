---
title: "Editor & diagnostics"
nav_order: 6
---

# Editor & diagnostics

## §5.1 Get IntelliSense in VS Code

The extension registers `.8bx` as its own language, `.8bg` as 8BitGraphics, and `.8ba` as 8BitAudio, all sent to the same language server as `.8bs`. From the binder, the server now gives: hover on your own names, completion, and go-to-definition — inside `.8bx` specifically, completion after `<` offers your components, props complete as snippets, and `</` closes the currently open element. Media diagnostics (`8BS21xx` / `8BS22xx`) reach the editor the same way.

**Hover on a hardware API shows the API every machine agrees on.** `@8bitscript/screen`, `text`, `input` and `raster` are one module per machine behind one import; the editor reads all nine and shows one member as the contract they share — `screen.blank(...)` with the doc the machines have in common, and nothing about any one machine. What differs is said, and only when it does:

- A member only some machines have lists where it exists: `Available on c64, c128, cx16, mega65 and web; not on vic20, pet, atari8 and nes.` When the file you are in is a machine's twin (`x.pet.8bs`), or the project's config names exactly one target, a member that machine lacks is called out first — **Not on pet** — because calling it there is a link error, not a no-op.
- A signature one machine disagrees on shows the portable one and names the dissenter: `On web: raster.at(line: usmallint, …)`.
- When each machine documents a member in its own words (`text.releaseCursor` is a different note on every KERNAL), the note for your machine — else the first — is shown labelled `On pet:`, with a count of the others, so an implementation note is never read as the contract.
- Completion after `screen.` lists the merged members; a machine-specific one carries its machines in the detail (`— web only`).
- Go to Definition opens the module for your file's machine, else the project's single target, else the first machine (in `8bs targets` order) that has the member — and the hover says which.

## §5.2 Read a diagnostic code

Every diagnostic has a stable `8BSnnnn` code, independent of its message wording. The BX-specific ones, straight from the compiler's own registry:

| Code | Means |
| --- | --- |
| 8BS1043 | Message catalog missing or not a catalog (`@8bitscript/i18n/catalog`) |
| 8BS1044 | Catalog schema mismatch between locales |
| 8BS1045 | Catalog `{placeholder}` set does not match the default locale |
| 8BS1046 | `i18n.format` could not fold |
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
| 8BS2101–2111 | `.8bg` — syntax, missing PNG, too-small source, unknown field, duplicate name, quantized colours, glyph adaptation. [graphics.md](../project/graphics.md) |
| 8BS2201–2215 | `.8ba` — syntax, missing WAV/FLAC or fallback, unknown waveform/note, PCM fallback, no driver, unroutable waveform, FFmpeg missing. [audio.md](../project/audio.md) |
