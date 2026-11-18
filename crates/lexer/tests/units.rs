//! One test per row of the syntax spec 5 lexical grammar, then the error
//! paths (E1, E2, E5, 8BS1002..8BS1008), UTF-16 spans and `.8bx`.

mod common;

use common::{lex, lex_kind};
use lexer::{KEYWORDS, RESERVED_WORDS, TYPE_NAMES, is_operand_token};
use syntax::{PartKind, SourceKind, TokenKind as K};

fn kinds(text: &str) -> Vec<(K, String)> {
    lex(text)
        .tokens
        .into_iter()
        .map(|t| (t.kind, t.text))
        .collect()
}

fn one(text: &str) -> (K, String) {
    let all = kinds(text);
    assert_eq!(all.len(), 1, "{text:?} gave {all:?}");
    all.into_iter().next().expect("one")
}

fn diags(text: &str) -> Vec<(String, String, u32, u32)> {
    lex(text)
        .diagnostics
        .into_iter()
        .map(|d| (d.code, d.message, d.start, d.length))
        .collect()
}

fn clean(text: &str) {
    assert!(diags(text).is_empty(), "{text:?}: {:?}", diags(text));
}

// ---- grammar rows ------------------------------------------------------

#[test]
fn row_comment_line_and_block_not_nested() {
    assert_eq!(one("// x y"), (K::Comment, "// x y".into()));
    assert_eq!(one("/* a\nb */"), (K::Comment, "/* a\nb */".into()));
    let t = kinds("/* a /* b */ c */");
    assert_eq!(t[0], (K::Comment, "/* a /* b */".into()));
    assert_eq!(t[1], (K::Identifier, "c".into()));
    // a line comment keeps its `\r`, as the JS scanner does
    assert_eq!(kinds("// x\r\ny")[0].1, "// x\r");
}

#[test]
fn row_ident() {
    for w in ["x", "_x", "x_1", "__", "Abc9"] {
        assert_eq!(one(w), (K::Identifier, w.into()));
    }
    // `$` and non-ASCII letters are not identifier characters
    assert_eq!(kinds("a$b").len(), 2);
}

#[test]
fn row_raw_ident_keeps_its_prefix_and_is_never_a_keyword() {
    for w in [
        "r#loop",
        "r#in",
        "r#mod",
        "r#u8",
        "r#asm6502",
        "r#struct",
        "r#x",
    ] {
        assert_eq!(one(w), (K::Identifier, w.into()));
    }
    // `r#asm6502 {` is not an asm block
    assert_eq!(kinds("r#asm6502 { x }").len(), 4);
    // `r` then `#` with no name after it is not a raw identifier
    assert_eq!(kinds("r#1")[0], (K::Identifier, "r".into()));
    assert_eq!(diags("r#1")[0].0, "8BS1003");
}

#[test]
fn row_macro() {
    for m in ["assert!", "assert_eq!", "assert_ne!", "panic!"] {
        assert_eq!(one(m), (K::Macro, m.into()));
    }
    // other names, a space, and `!=` stay what they were
    assert_eq!(kinds("foo!")[1], (K::Operator, "!".into()));
    assert_eq!(kinds("assert !x")[0].0, K::Identifier);
    assert_eq!(kinds("assert!= 1")[1], (K::Operator, "!=".into()));
    assert_eq!(kinds("assert!(x)")[0], (K::Macro, "assert!".into()));
    // `test`, `fail`, `assert` alone are plain identifiers (test spec P-1)
    for w in ["test", "assert", "fail", "panic"] {
        assert_eq!(one(w).0, K::Identifier);
    }
}

#[test]
fn row_scope_only_after_use() {
    let t = kinds("use @8bitscript::c64;");
    assert_eq!(t[1], (K::Scope, "@8bitscript".into()));
    assert_eq!(kinds("use @my-scope::x;")[1].1, "@my-scope");
    assert_eq!(kinds("pub use @a::b;")[2].0, K::Scope);
    // a comment between is skipped
    assert_eq!(kinds("use /* c */ @a::b;")[2].0, K::Scope);
    // elsewhere `@` is an unexpected character
    assert_eq!(diags("let a = @x;")[0].0, "8BS1003");
    assert_eq!(diags("@x")[0].1, "unexpected character '@'");
    clean("use @a::b;");
}

#[test]
fn row_keyword() {
    assert_eq!(KEYWORDS.len(), 24);
    for w in KEYWORDS {
        assert_eq!(one(w), (K::Keyword, w.into()), "{w}");
    }
    // old-syntax words are identifiers; the parser answers E21
    for w in [
        "function",
        "import",
        "export",
        "namespace",
        "from",
        "switch",
        "do",
    ] {
        assert_eq!(one(w).0, K::Identifier, "{w}");
    }
    // `component`/`state` are keywords of `.8bx` only
    assert_eq!(one("component").0, K::Identifier);
    assert_eq!(one("state").0, K::Identifier);
}

#[test]
fn row_reserved() {
    for w in RESERVED_WORDS {
        assert_eq!(one(w), (K::Keyword, w.into()), "{w}");
    }
    assert_eq!(
        RESERVED_WORDS,
        ["enum", "impl", "struct", "trait", "static", "type"]
    );
    assert_eq!(one("r#type").0, K::Identifier);
}

#[test]
fn row_type_name() {
    for w in TYPE_NAMES {
        assert_eq!(one(w), (K::Type, w.into()), "{w}");
    }
    assert!(TYPE_NAMES.contains(&"utinyint") && TYPE_NAMES.contains(&"u8"));
    assert_eq!(one("Int").0, K::Identifier);
}

#[test]
fn row_number() {
    let n = |s: &str| {
        let t = lex(s).tokens;
        assert_eq!(t.len(), 1, "{s}");
        (t[0].value, t[0].radix, t[0].is_decimal)
    };
    assert_eq!(n("12"), (Some(12.0), Some(10), None));
    assert_eq!(n("1_000"), (Some(1000.0), Some(10), None));
    assert_eq!(n("$FF"), (Some(255.0), Some(16), None));
    assert_eq!(n("$ff_00"), (Some(65280.0), Some(16), None));
    assert_eq!(n("0xFF"), (Some(255.0), Some(16), None));
    assert_eq!(n("0Xa"), (Some(10.0), Some(16), None));
    assert_eq!(n("0b1010"), (Some(10.0), Some(2), None));
    assert_eq!(n("0B1_1"), (Some(3.0), Some(2), None));
    assert_eq!(n("0"), (Some(0.0), Some(10), None));
    let d = lex("1.5").tokens;
    assert_eq!(
        (
            d[0].value,
            d[0].is_decimal,
            d[0].numerator,
            d[0].denominator
        ),
        (Some(1.5), Some(true), Some(15.0), Some(10.0))
    );
    let d = lex("0.025").tokens;
    assert_eq!(
        (d[0].numerator, d[0].denominator),
        (Some(25.0), Some(1000.0))
    );
    // `1.` is `1` then `.`; a range is not a fraction
    assert_eq!(kinds("1.").len(), 2);
    assert_eq!(kinds("0..5").len(), 3);
    assert_eq!(kinds("1..=5")[1], (K::Operator, "..=".into()));
    // `%` is only modulo, never a binary literal
    assert_eq!(kinds("%101")[0], (K::Operator, "%".into()));
    assert_eq!(kinds("x%2").len(), 3);
    // the value of a very large literal
    assert_eq!(
        lex("$FFFFFFFFFFFFFFFFFFFFFFFF").tokens[0].value,
        Some(7.922816251426434e28)
    );
    clean("1_000 $FF 0xFF 0b11 1.5");
}

#[test]
fn row_string() {
    assert_eq!(one("\"hi\""), (K::String, "\"hi\"".into()));
    assert_eq!(one("\"a\\\"b\""), (K::String, "\"a\\\"b\"".into()));
    assert_eq!(one("\"\"").0, K::String);
    clean("\"a\\\\\"");
    // a backslash before a newline does not swallow the next line
    let t = kinds("\"a\\\nb\"");
    assert_eq!(t[0].1, "\"a\\");
}

#[test]
fn row_template() {
    let t = lex("`HP ${hp:3} of ${max}`").tokens;
    assert_eq!(t.len(), 1);
    let parts = t[0].parts.clone().expect("parts");
    let shape: Vec<_> = parts
        .iter()
        .map(|p| (p.kind, p.start, p.end, p.source_start, p.source_end))
        .collect();
    assert_eq!(
        shape,
        vec![
            (PartKind::Text, 1, 4, None, None),
            (PartKind::Field, 4, 11, Some(6), Some(10)),
            (PartKind::Text, 11, 15, None, None),
            (PartKind::Field, 15, 21, Some(17), Some(20)),
        ]
    );
    // a `}` inside a quoted string in a field does not close it
    assert_eq!(lex("`a ${f(\"}\")} b`").tokens.len(), 1);
    clean("`a ${f(\"}\")} b` ``");
    assert_eq!(lex("``").tokens[0].parts, Some(vec![]));
}

#[test]
fn row_compile_time() {
    assert_eq!(one("#frames"), (K::CompileTime, "#frames".into()));
    let t = kinds("#frames(2, seconds)");
    assert_eq!(t[0].0, K::CompileTime);
    assert_eq!(kinds("#system()")[0].1, "#system");
}

#[test]
fn row_attr_open() {
    let t = kinds("#[test] fn");
    assert_eq!(t[0], (K::Punctuation, "#[".into()));
    assert_eq!(t[1], (K::Identifier, "test".into()));
    assert_eq!(t[2], (K::Punctuation, "]".into()));
    clean("#[address($D020)]");
    // its `]` is matched: a stray one is reported
    assert_eq!(diags("]")[0].0, "8BS1004");
    // `#` then a name is a compile-time word, not an attribute
    assert_eq!(kinds("#x")[0].0, K::CompileTime);
}

#[test]
fn row_asm_block() {
    let t = kinds("asm6502 { lda #1 }");
    assert_eq!(t[0], (K::Keyword, "asm6502".into()));
    assert_eq!(t[1], (K::AsmBlock, "{ lda #1 }".into()));
    // no space needed, newlines allowed, braces in comments and quotes ignored
    assert_eq!(kinds("asm6502{nop}")[1].1, "{nop}");
    assert_eq!(kinds("asm6502\n\n{ nop }")[1].1, "{ nop }");
    let body = "{ lda #'}' ; } and {\n ldx #\"}\" }";
    assert_eq!(kinds(&format!("asm6502 {body} x"))[1].1, body);
    // nested braces
    assert_eq!(kinds("asm6502 { a { b } c } d")[1].1, "{ a { b } c }");
    // no body: just the keyword
    assert_eq!(kinds("asm6502 x").len(), 2);
    clean("asm6502 { a { b } }");
}

#[test]
fn row_operator_maximal_munch() {
    for op in [
        "<<=", ">>=", "::", "->", "=>", "..=", "..", "==", "!=", "<=", ">=", "&&", "||", "<<",
        ">>", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "+", "-", "*", "/", "%", "&", "|",
        "^", "~", "!", "<", ">", "=",
    ] {
        assert_eq!(one(op), (K::Operator, op.into()), "{op}");
        clean(op);
    }
    let text = |s: &str| kinds(s).into_iter().map(|t| t.1).collect::<Vec<_>>();
    assert_eq!(text("x=-1"), ["x", "=", "-", "1"]);
    assert_eq!(text("a<<=b"), ["a", "<<=", "b"]);
    assert_eq!(text("a<<<b"), ["a", "<<", "<", "b"]);
    assert_eq!(text("a->b=>c"), ["a", "->", "b", "=>", "c"]);
    assert_eq!(text("a::b:c"), ["a", "::", "b", ":", "c"]);
    assert_eq!(text("0...5"), ["0", "..", ".", "5"]);
    assert_eq!(text("a&&&b"), ["a", "&&", "&", "b"]);
}

#[test]
fn row_punct() {
    for p in ["(", ")", "[", "]", "{", "}", ",", ";", ":", ".", "_"] {
        let t = kinds(p);
        assert_eq!(t[0], (K::Punctuation, p.into()), "{p}");
    }
    // `_` alone is punctuation; with more name characters it is an identifier
    assert_eq!(kinds("_ _a a_")[0].0, K::Punctuation);
    assert_eq!(kinds("_ _a a_")[1].0, K::Identifier);
    assert_eq!(kinds("(a)")[0].0, K::Punctuation);
}

#[test]
fn whitespace_is_space_tab_cr_lf_only() {
    assert_eq!(kinds(" \t\r\na \t b").len(), 2);
    assert_eq!(diags("a\u{a0}b")[0].0, "8BS1003");
    assert_eq!(diags("a\u{0}b")[0].1, "unexpected character '\u{0}'");
}

// ---- errors ------------------------------------------------------------

#[test]
fn e1_increment_decrement() {
    let d = diags("x++; y--;");
    assert_eq!(
        d,
        [
            (
                "8BS1101".into(),
                "8BitScript has no '++'; write 'x += 1'".into(),
                1,
                2
            ),
            (
                "8BS1101".into(),
                "8BitScript has no '--'; write 'x -= 1'".into(),
                6,
                2
            ),
        ]
    );
    // the token is still there for the parser
    assert_eq!(kinds("x++")[1], (K::Operator, "++".into()));
    // `a - -b` and `a -= 1` are fine
    clean("a - -b; a -= 1; a + +b;");
}

#[test]
fn e2_question_mark() {
    assert_eq!(
        diags("c ? a : b"),
        [(
            "8BS1101".into(),
            "write 'if c { a } else { b }' for a choice between two values".into(),
            2,
            1
        )]
    );
    assert_eq!(diags("a ?? b").len(), 2);
    assert_eq!(kinds("?")[0], (K::Operator, "?".into()));
}

#[test]
fn e5_single_quotes() {
    let msg = "8BitScript has no char type; write \"A\" for text or 65 for a number";
    assert_eq!(diags("'A'"), [("8BS1101".into(), msg.into(), 0, 3)]);
    // still one string token so the parser does not cascade
    assert_eq!(one("'A'"), (K::String, "'A'".into()));
    // an unterminated one reports E5 only, and is marked
    let l = lex("'ab");
    assert_eq!(l.diagnostics.len(), 1);
    assert_eq!(l.diagnostics[0].message, msg);
    assert_eq!(l.tokens[0].unterminated, Some(true));
    // an apostrophe inside a double-quoted string is fine
    clean("\"it's\"");
    // and inside a comment
    clean("// don't");
    // in a template field only `"` hides a brace
    assert!(lex("`${'}`").diagnostics.is_empty());
}

#[test]
fn error_8bs1002_unterminated_strings() {
    let d = diags("\"abc\nx");
    assert_eq!(
        d,
        [("8BS1002".into(), "unterminated string literal".into(), 0, 4)]
    );
    assert_eq!(lex("\"abc").tokens[0].unterminated, Some(true));
    assert_eq!(kinds("\"abc\nx")[1], (K::Identifier, "x".into()));
    assert_eq!(
        diags("`abc")[0],
        (
            "8BS1002".into(),
            "unterminated template string".into(),
            0,
            4
        )
    );
    assert_eq!(
        diags("`a ${b\nc"),
        [(
            "8BS1002".into(),
            "unterminated '${' field in template string".into(),
            3,
            3
        )]
    );
    // the unterminated field is still recorded for hover and completion
    let t = lex("`a ${b").tokens;
    let parts = t[0].parts.clone().expect("parts");
    assert_eq!(
        (parts[1].kind, parts[1].source_start, parts[1].source_end),
        (PartKind::Field, Some(5), Some(6))
    );
    // a backslash-newline ends a string: the escape never swallows a line
    assert_eq!(diags("\"a\\\nb\"").len(), 2);
}

#[test]
fn error_8bs1003_unexpected_character() {
    for ch in ["\\", "$", "#", "@", "\u{e9}", "`".trim_end_matches('`')] {
        if ch.is_empty() {
            continue;
        }
        let d = diags(&format!("a {ch} b"));
        assert_eq!(d.len(), 1, "{ch}");
        assert_eq!(d[0].0, "8BS1003");
        assert_eq!(d[0].1, format!("unexpected character '{ch}'"));
    }
    // `$` with no hex digit after it; `#` with no name; `#!` without `[`
    assert_eq!(diags("$ ")[0].0, "8BS1003");
    assert_eq!(diags("#!x").len(), 1);
    // old decorators are gone
    assert_eq!(diags("@address(1)")[0].0, "8BS1003");
}

#[test]
fn error_8bs1004_unmatched_bracket() {
    assert_eq!(
        diags("a)"),
        [("8BS1004".into(), "unmatched ')'".into(), 1, 1)]
    );
    assert_eq!(diags("(]")[0].1, "unmatched ']'");
    // a mismatched closer leaves the opener open: one more diagnostic
    let d = diags("(]");
    assert_eq!(d[1].0, "8BS1005");
    assert_eq!(diags("}")[0].1, "unmatched '}'");
}

#[test]
fn error_8bs1005_unclosed_bracket() {
    assert_eq!(
        diags("a ( b [ c {"),
        [
            ("8BS1005".into(), "unclosed '('".into(), 2, 1),
            ("8BS1005".into(), "unclosed '['".into(), 6, 1),
            ("8BS1005".into(), "unclosed '{'".into(), 10, 1),
        ]
    );
    // the `[` of `#[` is the bracket that stays open
    assert_eq!(
        diags("#[a")[0],
        ("8BS1005".into(), "unclosed '['".into(), 1, 1)
    );
}

#[test]
fn error_8bs1006_unterminated_block_comment() {
    let l = lex("a /* b\nc");
    assert_eq!(
        l.diagnostics[0].clone().message,
        "unterminated block comment"
    );
    assert_eq!((l.diagnostics[0].start, l.diagnostics[0].length), (2, 6));
    assert_eq!(l.tokens[1].text, "/* b\nc");
    // `/*/` is not a closed comment
    assert_eq!(diags("/*/")[0].0, "8BS1006");
    clean("/**/");
}

#[test]
fn error_8bs1007_unterminated_asm() {
    let d = diags("asm6502 { lda #1\n sta 2");
    assert_eq!(
        d[0],
        ("8BS1007".into(), "unterminated asm6502 block".into(), 8, 15)
    );
    // the block runs to the end of the file
    assert_eq!(lex("asm6502 { a").tokens[1].text, "{ a");
}

#[test]
fn error_8bs1008_invalid_number() {
    for (src, shown) in [("0x", "0x"), ("0b", "0b"), ("0x_", "0x_"), ("0B2", "0B")] {
        let d = diags(src);
        assert_eq!(d[0].0, "8BS1008", "{src}");
        assert_eq!(d[0].1, format!("invalid number literal '{shown}'"));
    }
    assert_eq!(lex("0x").tokens[0].value, Some(0.0));
}

// ---- spans -------------------------------------------------------------

#[test]
fn spans_are_utf16_code_units() {
    // U+1F600 is two UTF-16 units and four UTF-8 bytes; U+00E9 is one unit
    let text = "// \u{1F600}\nlet s = \"\u{e9}\u{1F600}\"; x";
    let l = lex(text);
    let units: Vec<u16> = text.encode_utf16().collect();
    for t in &l.tokens {
        let slice = &units[t.start as usize..(t.start + t.length) as usize];
        assert_eq!(String::from_utf16(slice).expect("utf16"), t.text);
    }
    let by = |s: &str| l.tokens.iter().find(|t| t.text == s).expect(s).start;
    assert_eq!(by("let"), 6);
    assert_eq!(by("\"\u{e9}\u{1F600}\""), 14);
    assert_eq!(l.tokens.last().expect("last").start, 21);
}

#[test]
fn diagnostic_spans_are_utf16() {
    let d = lex("\u{1F600}\u{1F600} @ \u{1F600}").diagnostics;
    assert_eq!(d.len(), 4);
    assert_eq!((d[0].start, d[0].length), (0, 2));
    assert_eq!((d[1].start, d[1].length), (2, 2));
    assert_eq!((d[2].start, d[2].length), (5, 1));
    // a diagnostic after astral text in an unterminated string
    let d = lex("\"\u{1F600}\u{1F600}").diagnostics;
    assert_eq!((d[0].start, d[0].length), (0, 5));
    let d = lex("/* \u{1F600}").diagnostics;
    assert_eq!((d[0].start, d[0].length), (0, 5));
    // the unclosed bracket after astral text
    let d = lex("\"\u{1F600}\" (").diagnostics;
    assert_eq!((d[0].start, d[0].length), (5, 1));
}

#[test]
fn template_parts_are_utf16() {
    let t = lex("`\u{1F600}${x}\u{e9}`").tokens;
    let parts = t[0].parts.clone().expect("parts");
    let shape: Vec<_> = parts
        .iter()
        .map(|p| (p.start, p.end, p.source_start))
        .collect();
    assert_eq!(shape, [(1, 3, None), (3, 7, Some(5)), (7, 8, None)]);
}

#[test]
fn crlf_counts_two_units_and_keeps_tokens_apart() {
    let l = lex("a\r\nb\r\n// c\r\nd");
    let starts: Vec<_> = l.tokens.iter().map(|t| (t.text.clone(), t.start)).collect();
    assert_eq!(
        starts,
        [
            ("a".into(), 0),
            ("b".into(), 3),
            ("// c\r".into(), 6),
            ("d".into(), 12)
        ]
    );
    let l = lex("/* a\r\n */ x");
    assert_eq!((l.tokens[1].start, l.tokens[0].length), (10, 9));
}

// ---- operands, `.8bx` ----------------------------------------------------

#[test]
fn operand_tokens() {
    let t = |s: &str| lex(s).tokens.into_iter().last();
    for yes in ["x", "1", "\"s\"", "`t`", "u8", "true", "false", ")", "]"] {
        assert!(is_operand_token(t(yes).as_ref()), "{yes}");
    }
    for no in [
        "if", "return", "}", "{", "+", ";", "=>", "x++", "#f", "assert!",
    ] {
        assert!(!is_operand_token(t(no).as_ref()), "{no}");
    }
    assert!(!is_operand_token(None));
}

fn bx(text: &str) -> Vec<(K, String)> {
    lex_kind(text, SourceKind::Bx)
        .tokens
        .into_iter()
        .map(|t| (t.kind, t.text))
        .collect()
}

#[test]
fn bx_keywords_and_tag_modes() {
    assert_eq!(bx("component state")[0].0, K::Keyword);
    assert_eq!(bx("component state")[1].0, K::Keyword);
    let t = bx("return <A b=\"x\" c={1}>hi {x}</A>;");
    let ks: Vec<K> = t.iter().map(|t| t.0).collect();
    assert_eq!(
        ks,
        [
            K::Keyword,
            K::BxTagOpen,
            K::Identifier,
            K::Identifier,
            K::Operator,
            K::String,
            K::Identifier,
            K::Operator,
            K::Punctuation,
            K::Number,
            K::Punctuation,
            K::BxTagEnd,
            K::BxText,
            K::Punctuation,
            K::Identifier,
            K::Punctuation,
            K::BxClosingTagOpen,
            K::Identifier,
            K::BxTagEnd,
            K::Punctuation,
        ]
    );
    assert_eq!(bx("<A />")[2].0, K::BxSelfClose);
}

#[test]
fn bx_less_than_is_a_comparison_after_a_value() {
    for src in ["a < b", "(a) < b", "x[1] < b", "1 < b", "array<u8, 4>"] {
        assert!(bx(src).iter().all(|t| t.0 != K::BxTagOpen), "{src}");
    }
    // `if (a) < b {` compares: a `)` never opens an element in the new syntax
    assert!(bx("if (a) < b { }").iter().all(|t| t.0 != K::BxTagOpen));
    for src in [
        "{ <A /> }",
        "=> <A />",
        "= <A />",
        "return <A />",
        "; <A />",
    ] {
        assert!(bx(src).iter().any(|t| t.0 == K::BxTagOpen), "{src}");
    }
}

#[test]
fn bx_errors() {
    let l = lex_kind("<A # b=\"x\"", SourceKind::Bx);
    let d: Vec<_> = l
        .diagnostics
        .iter()
        .map(|d| (d.code.as_str(), d.message.as_str(), d.start))
        .collect();
    assert_eq!(
        d,
        [
            ("8BS1039", "unexpected '#' inside a tag", 3),
            ("8BS1039", "unterminated tag", 0)
        ]
    );
    let l = lex_kind("<A>text", SourceKind::Bx);
    assert_eq!(l.diagnostics[0].message, "unclosed element");
    // in a tag a single-quoted string is still accepted
    let l = lex_kind("<A b='x' />", SourceKind::Bx);
    assert!(l.diagnostics.is_empty());
    // `.8bs` never makes tag tokens
    assert!(
        lex("return <A />")
            .tokens
            .iter()
            .all(|t| t.kind != K::BxTagOpen)
    );
}

#[test]
fn bx_expression_braces_return_to_the_tag() {
    let l = lex_kind("<A b={ {1} } c=\"d\" />", SourceKind::Bx);
    assert!(l.diagnostics.is_empty(), "{:?}", l.diagnostics);
    assert_eq!(l.tokens.last().expect("last").kind, K::BxSelfClose);
}

#[test]
fn a_huge_literal_overflows_to_infinity_and_serializes_as_null() {
    // Pins today's behaviour: the value is f64 infinity (as `parseFloat`
    // gives in the JS) and serde_json writes a non-finite float as null.
    let l = lex(&format!("${}", "F".repeat(300)));
    assert_eq!(l.tokens[0].value, Some(f64::INFINITY));
    let json = serde_json::to_value(&l).expect("serializes");
    assert!(json["tokens"][0]["value"].is_null());
}
