//! Golden token dumps over the hand-written new-syntax corpus. There is no JS
//! oracle for the new syntax, so every `*.tokens.json` was written by this
//! lexer (`BLESS=1 cargo test -p lexer --test golden`) and then read by hand
//! against the syntax spec; the diff of a changed dump is the review.

mod common;

use std::fs;

use common::{corpus, dir, lex_kind, read};
use oracle::canonical_json;
use syntax::TokenKind;

fn dump(name: &str, kind: syntax::SourceKind) -> String {
    let lexed = lex_kind(&read(name), kind);
    let value = serde_json::to_value(&lexed).expect("serialize");
    canonical_json(&value)
}

#[test]
fn every_corpus_file_matches_its_golden_dump() {
    let bless = std::env::var_os("BLESS").is_some();
    let files = corpus();
    assert!(files.len() >= 8, "corpus shrank: {}", files.len());
    for (name, kind) in files {
        let actual = dump(&name, kind);
        let golden = dir().join(format!("{name}.tokens.json"));
        if bless {
            fs::write(&golden, &actual).expect("write golden");
        }
        let expected = fs::read_to_string(&golden)
            .unwrap_or_else(|e| panic!("{name}: missing golden ({e}); run with BLESS=1"));
        assert!(actual == expected, "{name}: token dump differs from golden");
    }
}

#[test]
fn the_corpus_covers_every_token_kind_the_lexer_makes() {
    let mut seen = std::collections::BTreeSet::new();
    for (name, kind) in corpus() {
        for t in lex_kind(&read(&name), kind).tokens {
            seen.insert(serde_json::to_string(&t.kind).expect("kind"));
        }
    }
    let all = [
        TokenKind::Comment,
        TokenKind::String,
        TokenKind::Template,
        TokenKind::Number,
        TokenKind::Identifier,
        TokenKind::Keyword,
        TokenKind::Type,
        TokenKind::CompileTime,
        TokenKind::AsmBlock,
        TokenKind::Punctuation,
        TokenKind::Operator,
        TokenKind::BxTagOpen,
        TokenKind::BxTagEnd,
        TokenKind::BxSelfClose,
        TokenKind::BxClosingTagOpen,
        TokenKind::BxText,
        TokenKind::Macro,
        TokenKind::Scope,
    ];
    for kind in all {
        let name = serde_json::to_string(&kind).expect("kind");
        assert!(seen.contains(&name), "no corpus token of kind {name}");
    }
    // `decorator` is gone with `@name`; the new syntax never makes one.
    assert!(!seen.contains("\"decorator\""));
}

#[test]
fn the_corpus_reaches_every_diagnostic_the_lexer_can_give() {
    let mut messages = std::collections::BTreeSet::new();
    for (name, kind) in corpus() {
        for d in lex_kind(&read(&name), kind).diagnostics {
            messages.insert((
                d.code,
                d.message.split('\'').next().unwrap_or("").to_string(),
            ));
        }
    }
    let wanted = [
        ("8BS1002", "unterminated string literal"),
        ("8BS1002", "unterminated template string"),
        ("8BS1002", "unterminated "),
        ("8BS1003", "unexpected character "),
        ("8BS1004", "unmatched "),
        ("8BS1005", "unclosed "),
        ("8BS1006", "unterminated block comment"),
        ("8BS1007", "unterminated asm6502 block"),
        ("8BS1008", "invalid number literal "),
        ("8BS1039", "unterminated tag"),
        ("8BS1039", "unexpected "),
        ("8BS1101", "8BitScript has no "),
        ("8BS1101", "write "),
    ];
    for (code, prefix) in wanted {
        assert!(
            messages
                .iter()
                .any(|(c, m)| c == code && m.starts_with(prefix)),
            "corpus never gives {code} {prefix}"
        );
    }
}

#[test]
fn fixtures_stay_small() {
    let total: u64 = fs::read_dir(dir())
        .expect("dir")
        .filter_map(|e| e.ok()?.metadata().ok())
        .map(|m| m.len())
        .sum();
    assert!(total < 200 * 1024, "corpus is {total} bytes");
}
