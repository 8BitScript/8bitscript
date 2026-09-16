---
"@8bitscript/compiler": minor
"8bitscript-lang": minor
---

8BX element syntax is tokenized by the lexer, in tag, children and
expression modes, and read by the parser token by token — no more
re-scanning source text at a `<`. Every span is a token's, so a
diagnostic inside a `{…}` attribute or child points into the file
(and reaches the editor with the right range), `<` opens a tag only where
no value sits before it (`a < b`, `array<u8, 4>` and `x << 2` are what
they were; `if (x) <Foo />;` works), raw text between tags is one token
in which `don't`, `//` and `>` are just text, and a half-typed tag ends
with one diagnostic and a parser that keeps going. Text children are
normalized the JSX way, once, in the parser. `<Studio.Window />` names
parse; an element parses where a value is expected (a `?:` arm), for
its spans. The VS Code grammar colors `component`, tags, attributes and
embedded expressions in `.8bx`.
