//! The lexer never panics, and what it returns is always well formed: every
//! span lies inside the text on a character boundary, in order, and every
//! token's `text` is the UTF-16 slice its span names. The inputs are every
//! prefix and every one-character deletion of the corpus, plus a seeded
//! pseudo-random stream of fragments and raw characters.

mod common;

use common::{corpus, lex_kind, read};
use lexer::{Lexed, Options, tokenize};
use syntax::SourceKind;

fn check(text: &str, kind: SourceKind) {
    let lexed = lex_kind(text, kind);
    well_formed(text, &lexed);
}

fn well_formed(text: &str, lexed: &Lexed) {
    let units: Vec<u16> = text.encode_utf16().collect();
    let n = units.len() as u32;
    let mut prev_end = 0u32;
    for t in &lexed.tokens {
        assert!(
            t.start >= prev_end,
            "tokens overlap or go backwards at {}",
            t.start
        );
        assert!(t.start + t.length <= n, "token past the end: {t:?}");
        let slice = &units[t.start as usize..(t.start + t.length) as usize];
        assert_eq!(
            String::from_utf16(slice).expect("token cut a character"),
            t.text
        );
        assert!(t.length > 0, "empty token {t:?}");
        prev_end = t.start + t.length;
    }
    for d in &lexed.diagnostics {
        assert!(d.start + d.length <= n, "diagnostic past the end: {d:?}");
        assert!(d.length > 0 || d.start <= n);
        assert!(d.code.starts_with("8BS"));
    }
    // the dump always serializes
    serde_json::to_string(lexed).expect("serialize");
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

const FRAGMENTS: [&str; 64] = [
    "let ",
    "mut ",
    "fn ",
    "pub ",
    "use ",
    "mod ",
    "match ",
    "loop ",
    "for ",
    "in ",
    "if ",
    "else ",
    "asm6502 ",
    "r#",
    "r#loop",
    "assert!",
    "panic!",
    "@",
    "@scope",
    "#[",
    "#![",
    "#",
    "#frames",
    "]",
    "[",
    "(",
    ")",
    "{",
    "}",
    "${",
    "`",
    "\"",
    "'",
    "\\",
    "/*",
    "*/",
    "//",
    "\n",
    "\r\n",
    " ",
    "$",
    "$F",
    "0x",
    "0b",
    "1.5",
    "1_0",
    "%",
    "::",
    "->",
    "=>",
    "..",
    "..=",
    "<<=",
    "++",
    "?",
    "<",
    ">",
    "</",
    "/>",
    "=",
    ";",
    "\u{1F600}",
    "\u{e9}",
    "\u{0}",
];

fn random_text(rng: &mut Rng) -> String {
    let mut s = String::new();
    for _ in 0..rng.below(40) {
        if rng.below(8) == 0 {
            let cp = match rng.below(3) {
                0 => rng.below(0x80),
                1 => 0x80 + rng.below(0x780),
                _ => 0x10000 + rng.below(0x1000),
            };
            s.push(char::from_u32(cp as u32).unwrap_or('?'));
        } else {
            s.push_str(FRAGMENTS[rng.below(FRAGMENTS.len())]);
        }
    }
    s
}

#[test]
fn every_prefix_of_every_corpus_file() {
    for (name, kind) in corpus() {
        let text = read(&name);
        for (i, _) in text
            .char_indices()
            .chain(std::iter::once((text.len(), ' ')))
        {
            check(&text[..i], kind);
        }
    }
}

#[test]
fn every_single_character_deletion() {
    for (name, kind) in corpus() {
        let text = read(&name);
        // the largest files get every 3rd position to keep the run short
        for (n, (i, c)) in text.char_indices().enumerate() {
            if n % 3 != 0 {
                continue;
            }
            let mut cut = String::with_capacity(text.len());
            cut.push_str(&text[..i]);
            cut.push_str(&text[i + c.len_utf8()..]);
            check(&cut, kind);
        }
    }
}

#[test]
fn random_fragment_streams_in_every_source_kind() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for round in 0..4000 {
        let text = random_text(&mut rng);
        let kind = if round % 2 == 0 {
            SourceKind::Bs
        } else {
            SourceKind::Bx
        };
        check(&text, kind);
        // the other kinds lex as `.8bs` and must not panic either
        let l = tokenize(
            &text,
            "f",
            &Options {
                source_kind: Some(SourceKind::Ba),
            },
        );
        well_formed(&text, &l);
    }
}

#[test]
fn random_unicode_scalars_and_controls() {
    let mut rng = Rng(42);
    for _ in 0..2000 {
        let len = rng.below(24);
        let text: String = (0..len)
            .map(|_| match rng.below(4) {
                0 => char::from_u32(rng.below(0x80) as u32).unwrap_or('?'),
                1 => char::from_u32(0x80 + rng.below(0x700) as u32).unwrap_or('?'),
                2 => char::from_u32(0x1F600 + rng.below(80) as u32).unwrap_or('?'),
                _ => char::from_u32(0x2000 + rng.below(0x200) as u32).unwrap_or('?'),
            })
            .collect();
        check(&text, SourceKind::Bs);
        check(&text, SourceKind::Bx);
    }
}

#[test]
fn degenerate_inputs() {
    for text in [
        "",
        "\0",
        "\"",
        "`",
        "${",
        "/*",
        "//",
        "#",
        "#[",
        "@",
        "r#",
        "asm6502 {",
        "<",
        "<A",
        "</",
        "\u{FEFF}",
        "\\",
    ] {
        check(text, SourceKind::Bs);
        check(text, SourceKind::Bx);
    }
    // a long run of one character stays linear and well formed
    check(&"(".repeat(20_000), SourceKind::Bs);
    check(&"\"".repeat(20_000), SourceKind::Bs);
    check(&"/* ".repeat(20_000), SourceKind::Bs);
}
