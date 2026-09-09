# Writing the lexer

This file is for anyone — human or agent — changing
`packages/compiler/src/lexer`. Read the root [`AGENTS.md`](../../../../AGENTS.md)
and [`packages/compiler/AGENTS.md`](../../AGENTS.md) first. Those say what
the compiler is and where the lexer sits in it. This file is the rules for
the scanner itself.

The source of truth is `index.mjs`. A rule below that is not true of that
file is a bug in this file.

## The approach is a hand-written scanner

Do not replace this with a generator (flex, `moo`, a regex over the whole
file). The language is small, several tokens are context-sensitive, and an
editor asks for tokens on every keystroke. A generated table cannot look
at the previous significant token to decide whether `%101` is binary or
modulo, cannot swallow an `asm6502` body as one opaque span, and cannot
promise it will not throw on half-typed source.

Scan one character at a time. Match operators by **maximal munch against
the `OPERATORS` list**, longest first — never by greedily eating a run of
operator characters. Greed is how `x=-1` became the non-operator `=-`
(`compiler.test.mjs`, "operators lex by maximal munch, not greed").
Matching only spellings the language recognises cannot produce a token
the parser has no rule for.

## Never throw

`tokenize()` always returns `{ tokens, diagnostics }`. Half-typed source
is the normal input, not an exceptional one. An unterminated string, an
unclosed `{`, a `0x` with no digits: record a diagnostic, emit the token
anyway (so the rest of the file still colourises and still parses), and
keep going. Recovery that drops the rest of the file is a bug.

The one exception that *does* stop is an unterminated `/*` comment: there
is nothing after it to recover into.

## Tokens carry spans; nothing else invents a position

Every token has `start` and `length` (and `text`, which is
`source.slice(start, start + length)`). Diagnostics are built from those.
A later pass that recomputes a column by counting newlines is guessing,
and the guess will be wrong the first time someone types a `\r\n` or a
tab. The parser re-lexes a template field by slicing the source and
*adding the field's `sourceStart` back onto every inner token* — that
only works because the inner offsets are honest.

## A source newline always ends a string

`"`, `'`, and `` ` `` strings are single-line. An unterminated quote
reports on its own line rather than swallowing the rest of the file
(`8BS1002`). A `\` does **not** continue the string onto the next line:
`skipStringEscape()` refuses to step over a newline. `\"` and `\n` (the
two characters backslash and `n`) are still escapes; a backslash followed
by an actual line break is an unterminated string.

## `%` vs binary, `$` vs identifier

`$` is not an identifier character. It introduces a hex literal (`$900F`).
A language aimed at this hardware gives the assembly spelling priority,
and `$` has no operator that conflicts with that.

`%` is both a binary-literal sigil (`%101`) and the modulo operator
(`x%2`). The binary reading is only taken where a *value* is expected.
After an operand, `%` is modulo. That lookbehind:

- **skips comments** — `x/*c*/%2` is modulo, not a binary `2`. Comments
  are tokens (the parser drops them; a tool that wants their spans can
  find them), so the previous *token* is not the previous *operand*.
- **treats `true` and `false` as operands** — they are literals.
- **treats postfix `++` / `--` as leaving a value in place.**
- **treats `)` and `]` as operands**; `}` is a block closer, not a value.

`$` and `%` in value position, `0x` / `0b`, and decimal digits all share
one number scanner. An empty digit run (`0x`) is `8BS1008` with `value: 0`,
never a NaN travelling through the checker. Decimal fractions (`0.5`) are
radix 10 only, only when a digit follows the `.` (`1.` is `1` then `.`),
and are stored as an exact `numerator`/`denominator` pair — `value` on
those tokens is cosmetic; the `#frames(...)` fold is what reads the pair.

## `#name` is one token

A compile-time function is spelled `#name`. The `#` is the contract that
8BitScript resolves it before any target toolchain runs; a plain
`name(...)` always runs on the machine. The lexer makes one
`CompileTime` token of the whole spelling so the parser cannot see a
punctuation `#` and an identifier that someone might declare. A new
compile-time function is a new `#name`, not a new reserved word. See the
root `AGENTS.md` section "A new construct picks a side, and its spelling
says which".

`@address` is the same shape on the decorator side: one `Decorator`
token, `@` plus the name.

## Keywords and type names are classified here

`KEYWORDS` and `TYPE_NAMES` are decided at lex time, not by the parser
looking at an identifier. That is how `switch` can be a keyword with no
parse rule — writing one is an honest `8BS1101`, not a name that will
silently become illegal when a parse rule lands.

Integer spellings come from `INTEGER_TYPE_NAMES` in
`packages/compiler/src/types`. Do not add `u8` or `utinyint` to the
lexer's set by hand; the checker, the backends, and hover all read the
same registry. `bool`, `void`, `string`, `ptr`, `array`, `volatile` are
the extra type names the registry does not own.

## Opaque regions are not 8BitScript

- **Comments** (`//`, `/* */`) are tokens of kind `comment`. The parser
  strips them so every parse rule is free of trivia. They still exist in
  the token list, which is why `%`-context has to skip them.
- **`asm6502 { ... }`** is 6502 assembly. Lexing the body as 8BitScript
  reports `#` in `lda #$06` as an unexpected character, which is simply
  wrong. The whole `{ ... }` is one `AsmBlock` token, handed to the
  backend untouched. Brace depth inside the body **skips `;` comments
  and quotes** — assembly comments like `; wait for { vsync` are not
  braces. Nested `{` / `}` that really are in the assembly (a ca65
  `.scope`) still count.

Do not add a third opaque region without a test that the 8BitScript
scanner does not run inside it.

## Templates are one token; fields are re-lexed

A backtick string is one `Template` token with `parts` marking each run
of literal text and each `${...}` field's source span. The parser (and
hover/completion) re-lex that span and parse it as an ordinary
expression plus an optional `:width`. Offsets in the inner tokens are
shifted back into the file, so a diagnostic inside a field lands on the
right characters.

Braces nest inside a field so a future `{`-bearing expression still ends
at the right `}`. Quoted text inside a field does not count toward that
depth — `` `${ "{" }` `` is one field, not an unclosed one. An
unterminated field is recorded anyway: the person is still typing, and
hover inside it is exactly what they want.

## Bracket matching lives here

Unmatched and unclosed brackets are lexical diagnostics (`8BS1004`,
`8BS1005`) because an editor wants them under the cursor before a parse.
`asm6502` bodies and template fields consume their own braces and do
**not** push them on this stack — those braces are not 8BitScript.

This is parser-shaped work. It stays because the alternative is the
editor waiting on a parse that the rest of a broken file may not reach.
Do not grow it into statement recovery; that is the parser's job.

## What not to add

- **Do not tokenise whitespace.** Nothing needs those spans today.
- **Do not put type-checking in the lexer.** Range errors (`8BS1021`)
  belong in the checker; a number token's `value` is the integer the
  digits named, even if it will not fit in `u8`.
- **Do not use `Number.parseFloat` as a value anything arithmetic
  reads.** Decimal tokens keep an exact pair for `#frames(...)`.
- **Do not invent a runtime builtin as a `#name`, or a compile-time
  function as a bare name.** The spelling is the side.
- **Do not add a keyword, type spelling, literal form, or diagnostic
  only here.** The root `AGENTS.md` section "Changing a core part of the
  language" is the rest of the list: docs, hover, the language server,
  the VS Code grammar and snippets, and a test in `compiler.test.mjs`
  (or the feature's own file) that would have failed before the change.

## Tests

`packages/compiler/test/compiler.test.mjs` (the "shipped bug" lexer
cases), `strings.test.mjs` (templates), and `durations.test.mjs`
(decimal literals) are the suite. A lexer change that is not a
reproduction in one of those is a change that can ship twice.
