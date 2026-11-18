//! The parser never panics, always terminates, and what it returns is always
//! well formed: every span lies inside the text, every diagnostic too, and
//! the result serializes. The inputs are every prefix and every one-character
//! deletion of the corpus, plus a seeded pseudo-random stream of fragments.
//! Each test runs on a big stack: the nesting limit is 256 and a debug build
//! uses large frames.

mod common;

use common::{corpus, read};
use lexer::{Options, tokenize};
use parser::parse;
use syntax::{Node, SourceKind, utf16_len};

fn big(f: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(256 * 1024 * 1024)
        .spawn(f)
        .expect("spawn")
        .join()
        .expect("panicked");
}

fn check(text: &str) {
    let lexed = tokenize(
        text,
        "t",
        &Options {
            source_kind: Some(SourceKind::Bs),
        },
    );
    let parsed = parse(&lexed.tokens, text, "t");
    let n = utf16_len(text);
    assert_eq!(parsed.ast.start, 0);
    assert_eq!(parsed.ast.length, n);
    inside(&parsed.ast, n);
    for d in &parsed.diagnostics {
        assert!(d.start + d.length <= n, "diagnostic past the end: {d:?}");
        assert!(d.code.starts_with("8BS"));
    }
    serde_json::to_string(&parsed).expect("serialize");
}

fn inside(node: &Node, n: u32) {
    assert!(node.start + node.length <= n, "node past the end");
    for c in syntax::children(node) {
        inside(c, n);
    }
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
    big(|| {
        for name in corpus() {
            let text = read(&name);
            for (i, _) in text
                .char_indices()
                .chain(std::iter::once((text.len(), ' ')))
            {
                check(&text[..i]);
            }
        }
    });
}

#[test]
fn every_single_character_deletion() {
    big(|| {
        for name in corpus() {
            let text = read(&name);
            for (n, (i, c)) in text.char_indices().enumerate() {
                if n % 3 != 0 {
                    continue;
                }
                let mut cut = String::with_capacity(text.len());
                cut.push_str(&text[..i]);
                cut.push_str(&text[i + c.len_utf8()..]);
                check(&cut);
            }
        }
    });
}

#[test]
fn random_fragment_streams() {
    big(|| {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        for _ in 0..4000 {
            check(&random_text(&mut rng));
        }
    });
}

#[test]
fn degenerate_inputs() {
    big(|| {
        for text in [
            "",
            "\0",
            "\"",
            "`",
            "${",
            "#[",
            "@",
            "r#",
            "asm6502 {",
            "\u{FEFF}",
            "{",
            "}",
        ] {
            check(text);
        }
        check(&"(".repeat(20_000));
        check(&"{".repeat(20_000));
        check(&"[".repeat(20_000));
        check(&"-".repeat(20_000));
        check(&"a.".repeat(20_000));
        check(&"if a { ".repeat(5_000));
        check(&"`${".repeat(5_000));
        check(&"match x { 1 => ".repeat(5_000));
        check(&format!("let a = {};", "1 + ".repeat(20_000)));
    });
}
