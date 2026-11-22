//! `media_tokens_to_scan` over one media module's tokens: the import scan reads the same kinds,
//! offsets and text the media lexer produced.

use front::module::{media_tokens_to_scan, parse_module};
use media::lexer::{MediaTokenKind, tokenize_media};
use resolver::imports::find_imports;
use syntax::TokenKind;

const TEXT: &str = "// the hero\nsprite hero { source \"hero.png\" size 16x16 }\n";

#[test]
fn every_media_token_converts_with_its_kind_offsets_and_text() {
    let (tokens, _) = tokenize_media(TEXT, "a.8bg", ".8bg");
    let scan = media_tokens_to_scan(&tokens);
    assert_eq!(scan.len(), tokens.len());
    for (media, scanned) in tokens.iter().zip(&scan) {
        let kind = match media.kind {
            MediaTokenKind::Comment => TokenKind::Comment,
            MediaTokenKind::String => TokenKind::String,
            MediaTokenKind::Number => TokenKind::Number,
            MediaTokenKind::Identifier => TokenKind::Identifier,
            MediaTokenKind::Punctuation => TokenKind::Punctuation,
        };
        assert_eq!(scanned.kind, kind);
        assert_eq!((scanned.start, scanned.length), (media.start, media.length));
        assert_eq!(scanned.text, media.text);
    }
    let kinds: Vec<_> = scan.iter().map(|t| t.kind).collect();
    for kind in [
        TokenKind::Comment,
        TokenKind::Identifier,
        TokenKind::String,
        TokenKind::Punctuation,
    ] {
        assert!(kinds.contains(&kind), "{kind:?}");
    }
    assert!(find_imports(&scan).is_empty());
}

#[test]
fn a_media_module_scans_through_the_driver_without_a_tree() {
    let mut diagnostics = Vec::new();
    let (module, bound) = parse_module("a.8bg", TEXT, &mut diagnostics, None);
    assert!(module.ast.is_none() && module.media.is_some());
    assert!(bound.symbols.is_empty());
    assert!(!module.tokens.is_empty());
}
