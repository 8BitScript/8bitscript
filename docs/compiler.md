---
title: Compiler
nav_order: 40
---

# Compiler

The `@8bitscript/compiler` package is the single implementation behind
`8bs check`, `8bs build`, and the language server. Every layer is a pure
function over the previous one's output (plus source text for spans); only
the linker touches the filesystem.

## Pipeline

| Layer | Input | Output |
| --- | --- | --- |
| lexer | source text (`.8bs` or `.8bx`) | tokens and lexical diagnostics; in `.8bx`, tag/children/expression modes give element syntax its own tokens |
| parser | tokens | AST and syntax diagnostics |
| fold | AST | the same tree, with `#name(...)` calls resolved (`#frames`, `#system`, `#fact`, `#locale`, `#package`) |
| catalogs | `@8bitscript/i18n/catalog` | the selected `src/i18n/<locale>.8bs`, schema-checked against the default locale, missing keys filled from the fallback, Latin extras transliterated, `i18n.format` folded to a literal |
| binder | AST | symbols, scopes, binding diagnostics |
| checker | AST | type/range/component diagnostics |
| 8BX elaboration | AST with BX nodes | core AST: a component is a function (two, around its `<slot />`), an element is a call to it; `state` is a template global per field, cloned per instance by the linker (no BX in backends) |
| IR / backends | AST | the image, once a backend emits one. MOS (6502 family, including HuC6280 `ST0`/`ST1`/`ST2`), SM83 (Game Boy), Z80 (with `port.read`/`port.write` for `IN`/`OUT`), 6809, 8048, F8, and WebAssembly |

Two source kinds share this pipeline, and two more join it as their own
front ends:

| Extension | Kind | Grammar |
| --- | --- | --- |
| `.8bs` | 8BitScript | core language |
| `.8bx` | 8BitX | core language + 8BX elements and components |
| `.8bg` | 8BitGraphics | sprite declarations; not 8BitScript |
| `.8ba` | 8BitAudio | instrument / sample / song declarations; not 8BitScript |

`.8bg` and `.8ba` have their own lexer and parser
(`packages/compiler/src/media/`). The program entry stays `.8bs`. The
linker opens the named PNG or WAV. See [portable graphics](project/graphics.md)
and [portable audio](project/audio.md).

Graphics diagnostics (`8BS21xx`) and audio diagnostics (`8BS22xx`):

| Code | Means |
| --- | --- |
| 8BS2101–2109 | `.8bg` syntax, missing source/size, duplicate name, invalid size |
| 8BS2110 | More colours than the sprite can hold (warning; quantized) |
| 8BS2111 | Adapted: software glyph, colours dropped, or frames collapsed |
| 8BS2201–2209 | `.8ba` syntax, missing source/fallback, unknown waveform/note |
| 8BS2210 | PCM replaced by the declared synth fallback |
| 8BS2211 | No audio driver; playback omitted |
| 8BS2212 | Waveform the target cannot route |
| 8BS2213 | FLAC source needs FFmpeg on PATH |
| 8BS2214 | Missing required field |
| 8BS2215 | Song names an unknown instrument |

## Editor and CLI contract

`analyze()` never throws. Diagnostics use stable `8BS` codes; spans come
from tokens, not recomputed from file text.

Import resolution is optional in `analyze()` (enabled for `8bs check` and
`file:` documents in the language server) because it is the only part that
reads the module graph on disk.

`link()` reads every module in the graph as far as its own symbols
first, binds each import that names an exported component to that
component, then finishes each module — element checks, elaboration,
folding, checking, lowering — and links the IR. Backends receive
optimized IR; they do not parse 8BX. A component call whose arguments are
all compile-time values is inlined by the linker's optimizer, so a static
composition costs what hand-written calls would.

Catalog diagnostics (`packages/compiler/src/i18n`):

| Code | Means |
| --- | --- |
| 8BS1043 | `@8bitscript/i18n/catalog` with no `src/i18n/<locale>.8bs`, or a file that is not exported namespaces of string consts |
| 8BS1044 | Two locale catalogs do not export the same namespaces and string const names |
| 8BS1045 | A catalog string's `{name}` placeholders do not match the default locale's |
| 8BS1046 | `i18n.format` could not fold: a missing param, a non-const argument, or a record used somewhere other than as its second argument |

## Debug output: `.lst` and `.8bs.debug.json`

`8bs build --debug` (native/MOS targets only — the WebAssembly backend
has no listing yet) writes two extra files next to the artifact:

- **`<name>.lst`** — a human-readable assembly listing: address, encoded
  bytes, and mnemonic, grouped into sections by source file, function
  (or component), and inline origin, with the source line shown inline
  where it's known.
- **`<name>.8bs.debug.json`** — the same information as versioned JSON
  (`{ format: "8bitscript-debug", version: 1, ... }`), for the VS Code
  extension or another tool to consume instead of scraping the listing.

Both come from data the assembler already produces for every build
(`asm/assemble.ts`'s `ListingLine`: address, bytes, assembly text) —
`--debug` doesn't run a second pass or a disassembler, it keeps and
serializes what already exists, plus **provenance**: `mos/provenance.ts`'s
`SourceRef`-shaped `{ source, function, origin, component }`, carried on
every `Directive` from the moment `lower/index.ts` emits it (stamped once,
in `Lowerer.emit()`, from whichever IR statement is currently being
lowered — not re-derived per instruction) through branch relaxation
(`asm/relax.ts` copies a relaxed branch's own provenance onto its
replacement, tagged `generated: { reason: 'branch-relaxation' }`) and the
final linked program.

`source` reuses the compiler's own span shape — `{ file, start, length }`,
the same triple `diagnostic()` (`diagnostics/index.mjs`) already takes —
rather than a second source-location system; line/column are resolved on
demand from the file's own text (`positionAt`), not stored redundantly on
every instruction. `function` is the 8BitScript function (or, once a
component lowers to something the mos backend can tell apart from an
ordinary function, the component) currently being lowered; `origin` is
set only on an inlined statement, and names the function it was inlined
*from* — the linker's inliner (`linker/optimize.mjs`) already tags an
inlined block with this (`{ kind: 'block', origin: callee.name, body }`),
originally for `--size`'s own per-function breakdown; the debug map is a
second reader of the same field, not a second mechanism. An inlined
statement's own span resolves against the **origin function's** file, not
the caller's, since a cloned statement's `start`/`length` are still
offsets into wherever it was originally written.

`address` (the CPU/runtime address) and `artifactOffset` (the byte offset
into `BuildResult.bytes`, the linked code+data image `build()` returns)
are kept as distinct fields on purpose — a Commodore `.prg`'s 2-byte load
address, an Atari `.xex`'s segment headers, and an NES `.nes`'s iNES
header each mean a CPU address is not a file offset, and `artifactOffset`
is relative to the linked image `build()` produces, before whatever a
target's own image-wrapping step (`image.ts`, `image-nes.ts`,
`image-atari8.ts`) adds after it returns.

Not every instruction has a `source`: code a target's start-up sequence,
the wait-frame or multiply helper routines, or the string/const-array
data section emit is compiler structure, not a lowered source statement —
its listing entry (and debug-map instruction) carries `source: null`
rather than a fabricated span. The debug map's `symbols` array separately
lists every named global (from the zero-page allocator) and function
(from its linked label address), so a consumer can show `score` instead
of `$18` without walking every instruction to find where it's read.
