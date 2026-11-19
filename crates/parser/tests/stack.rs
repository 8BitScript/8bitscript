//! The parser must fit a 1 MB stack (the wasm default; a release build
//! overflows at 512 KB without the nesting limit). Debug frames are much
//! larger, so this runs in release mode only:
//! `cargo test -p parser --release --test stack`.
#![cfg(not(debug_assertions))]

use lexer::{Options as LexOptions, tokenize};
use parser::{Options, parse};
use syntax::SourceKind;

const STACK: usize = 1024 * 1024;

fn parse_on_small_stack(text: String) -> usize {
    parse_kind_on_small_stack(text, SourceKind::Bs)
}

fn parse_kind_on_small_stack(text: String, kind: SourceKind) -> usize {
    std::thread::Builder::new()
        .stack_size(STACK)
        .spawn(move || {
            let lexed = tokenize(
                &text,
                "t",
                &LexOptions {
                    source_kind: Some(kind),
                },
            );
            let options = Options {
                source_kind: Some(kind),
            };
            parse(&lexed.tokens, &text, "t", &options).diagnostics.len()
        })
        .expect("spawn")
        .join()
        .expect("the parser overflowed a 1 MB stack")
}

#[test]
fn worst_case_nesting_fits_in_one_megabyte() {
    let n = 20_000;
    let inputs = [
        format!("let a = {}1{};", "(".repeat(n), ")".repeat(n)),
        format!("fn f() {}{}", "{".repeat(n), "}".repeat(n)),
        format!("let a = {}1;", "-".repeat(n)),
        format!("let a = {}1;", "!-~".repeat(n)),
        format!("let a = {}1{};", "[".repeat(n), "]".repeat(n)),
        format!("fn f() {}{}", "if a { ".repeat(n), "}".repeat(n)),
        format!("fn f() {{ {} }}", "if a { } else ".repeat(n)),
        format!(
            "fn f(x: u8) {}{}",
            "match x { 1 => ".repeat(n),
            "}".repeat(n)
        ),
        format!("fn f() {}{}", "while a { ".repeat(n), "}".repeat(n)),
        format!("fn f() {}{}", "for i in 0..9 { ".repeat(n), "}".repeat(n)),
        format!("fn f() {}{}", "loop { ".repeat(n), "}".repeat(n)),
        format!("let a = {}1;", "`${".repeat(n)),
        format!("let a: {}u8{};", "ptr<".repeat(n), ">".repeat(n)),
        format!("let a: {}u8{};", "[".repeat(n), "; 2]".repeat(n)),
        format!("let a = {}1;", "{ a: ".repeat(n)),
        format!("let a = x{};", ".b".repeat(n)),
        format!("let a = x{};", "(1)".repeat(n)),
        format!("let a = x{};", "[1]".repeat(n)),
        format!("let a = 1{};", " + 1".repeat(n)),
        format!("let a = {}1;", "x = ".repeat(n)),
        format!("let a = {}1;", "if a { ".repeat(n)),
        format!("mod M {}{}", "mod N { ".repeat(n), "}".repeat(n)),
        format!("{}fn f() {{}}", "#[a(".repeat(n)),
    ];
    for text in inputs {
        let head = text.chars().take(24).collect::<String>();
        let diagnostics = parse_on_small_stack(text);
        assert!(diagnostics > 0, "{head}: expected a diagnostic");
    }
}

#[test]
fn worst_case_component_nesting_fits_in_one_megabyte() {
    let n = 20_000;
    for text in [
        format!("{}{}", "component C() { ".repeat(n), "}".repeat(n)),
        format!("{}1;", "state a = ".repeat(n)),
        format!("component C({}", "a: ptr<".repeat(n)),
    ] {
        let head: String = text.chars().take(24).collect();
        let diagnostics = parse_kind_on_small_stack(text, SourceKind::Bx);
        assert!(diagnostics > 0, "{head}: expected a diagnostic");
    }
}

#[test]
fn the_nesting_limit_still_parses_ordinary_depth() {
    let text = format!("let a = {}1{};", "(".repeat(40), ")".repeat(40));
    assert_eq!(parse_on_small_stack(text), 0);
}
