# @8bitscript/i18n

## 0.22.0

### Patch Changes

- @8bitscript/text@0.22.0

## 0.21.0

### Patch Changes

- @8bitscript/text@0.21.0

## 0.20.0

### Patch Changes

- @8bitscript/text@0.20.0

## 0.19.1

### Patch Changes

- @8bitscript/text@0.19.1

## 0.19.0

### Patch Changes

- @8bitscript/text@0.19.0

## 0.18.0

### Patch Changes

- @8bitscript/text@0.18.0

## 0.17.0

### Patch Changes

- @8bitscript/text@0.17.0

## 0.16.0

### Patch Changes

- @8bitscript/text@0.16.0

## 0.15.0

### Minor Changes

- 758765d: Add project message catalogs (`src/i18n/<locale>.8bs`, imported as `@8bitscript/i18n/catalog`), compile-time `i18n.format`, Latin transliteration into the portable set, and `Input.CONFIRM_LABEL` on each machine's input layer. One locale still means one binary; projects without catalogs are unchanged.

### Patch Changes

- @8bitscript/text@0.15.0

## Unreleased

### Minor Changes

- Add `@8bitscript/i18n/catalog` (project `src/i18n/<locale>.8bs` namespaces, compile-time `i18n.format`, Latin transliteration) and `@8bitscript/i18n/messages` (`printLine`, `clearLine`) for layout padding. Words stay out of this package; number grouping stays `Locale.*` / `./number`.

## 0.14.0

### Minor Changes

- 0cab778: New: `@8bitscript/i18n`, what the build's locale is like at compile time. The bare import is `Locale.DECIMAL` and `Locale.GROUP` — the locale's two number separators, as the ASCII codes `text.putChar` takes — as one file per locale inside the package (`index.8bs`, `index.de.8bs`, `fr`, `it`, `nl`, `pt-br`), picked by `--locale` through the resolver's locale twin rule, so a program names no locale and a build that reads neither links nothing. `@8bitscript/i18n/number` prints a number grouped in threes with `Locale.GROUP`, right-aligned in a field, through `@8bitscript/text` — `12,345` in an English build and `12.345` in a German one from the same call — at its own subpath so a program that prints zero-padded HUD fields carries none of it. Strings stay the program's own, in its `strings.<locale>.8bs` twins.

### Patch Changes

- @8bitscript/text@0.14.0
