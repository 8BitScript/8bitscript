#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;

use lexer::{Options, tokenize};
use parser::{Parsed, parse};
use syntax::{Node, SourceKind};

pub fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus")
}

/// The `.8bs` sources of the corpus, sorted.
pub fn corpus() -> Vec<String> {
    let mut files: Vec<String> = fs::read_dir(dir())
        .expect("corpus dir")
        .filter_map(|e| {
            let name = e.ok()?.file_name().into_string().ok()?;
            name.ends_with(".8bs").then_some(name)
        })
        .collect();
    files.sort();
    files
}

pub fn read(name: &str) -> String {
    fs::read_to_string(dir().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// Lex and parse as `.8bs`, as the compiler does. Runs on a big stack: the
/// nesting limit is 256 and a debug build uses large frames.
pub fn parse_text(text: &str) -> Parsed {
    let text = text.to_string();
    std::thread::Builder::new()
        .stack_size(256 * 1024 * 1024)
        .spawn(move || {
            let lexed = tokenize(
                &text,
                "t",
                &Options {
                    source_kind: Some(SourceKind::Bs),
                },
            );
            parse(&lexed.tokens, &text, "t")
        })
        .expect("spawn")
        .join()
        .expect("parser panicked")
}

/// Lex and parse as `.8bx`.
pub fn parse_bx_text(text: &str) -> Parsed {
    let text = text.to_string();
    std::thread::Builder::new()
        .stack_size(256 * 1024 * 1024)
        .spawn(move || {
            let lexed = tokenize(
                &text,
                "t",
                &Options {
                    source_kind: Some(SourceKind::Bx),
                },
            );
            parse(&lexed.tokens, &text, "t")
        })
        .expect("spawn")
        .join()
        .expect("parser panicked")
}

/// The `.8bx` sources of the corpus, sorted.
pub fn corpus_bx() -> Vec<String> {
    let mut files: Vec<String> = fs::read_dir(dir())
        .expect("corpus dir")
        .filter_map(|e| {
            let name = e.ok()?.file_name().into_string().ok()?;
            name.ends_with(".8bx").then_some(name)
        })
        .collect();
    files.sort();
    files
}

/// The messages of the parser's diagnostics, in order.
pub fn messages(text: &str) -> Vec<String> {
    parse_text(text)
        .diagnostics
        .into_iter()
        .map(|d| d.message)
        .collect()
}

/// Every node under `root`, pre-order.
pub fn nodes(root: &Node) -> Vec<&Node> {
    let mut out = Vec::new();
    syntax::walk(root, &mut |n, _| out.push(n));
    out
}
