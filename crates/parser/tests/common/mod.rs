#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;

use lexer::{Options as LexOptions, tokenize};
use parser::{Options, Parsed, parse};
use syntax::{Node, SourceKind};

pub fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus")
}

/// The `.8bs` and `.8bx` sources of the corpus, sorted.
pub fn corpus() -> Vec<String> {
    let mut files: Vec<String> = fs::read_dir(dir())
        .expect("corpus dir")
        .filter_map(|e| {
            let name = e.ok()?.file_name().into_string().ok()?;
            (name.ends_with(".8bs") || name.ends_with(".8bx")).then_some(name)
        })
        .collect();
    files.sort();
    files
}

pub fn read(name: &str) -> String {
    fs::read_to_string(dir().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// The kind of a corpus file, from its extension.
pub fn kind_of(name: &str) -> SourceKind {
    if name.ends_with(".8bx") {
        SourceKind::Bx
    } else {
        SourceKind::Bs
    }
}

/// Lex and parse a file of `kind`, as the compiler does. Runs on a big
/// stack: the nesting limit is 256 and a debug build uses large frames.
pub fn parse_kind(text: &str, kind: SourceKind) -> Parsed {
    let text = text.to_string();
    std::thread::Builder::new()
        .stack_size(256 * 1024 * 1024)
        .spawn(move || {
            let lexed = tokenize(
                &text,
                "t",
                &LexOptions {
                    source_kind: Some(kind),
                },
            );
            parse(
                &lexed.tokens,
                &text,
                "t",
                &Options {
                    source_kind: Some(kind),
                },
            )
        })
        .expect("spawn")
        .join()
        .expect("parser panicked")
}

pub fn parse_text(text: &str) -> Parsed {
    parse_kind(text, SourceKind::Bs)
}

/// Lex and parse as `.8bx`.
pub fn parse_bx_text(text: &str) -> Parsed {
    parse_kind(text, SourceKind::Bx)
}

/// The messages of a `.8bx` file's parser diagnostics.
pub fn messages_bx(text: &str) -> Vec<String> {
    parse_kind(text, SourceKind::Bx)
        .diagnostics
        .into_iter()
        .map(|d| d.message)
        .collect()
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
