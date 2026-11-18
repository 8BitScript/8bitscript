#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;

use lexer::{Lexed, Options, tokenize};
use syntax::SourceKind;

pub fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus")
}

/// The source files of the corpus, sorted, with their kind.
pub fn corpus() -> Vec<(String, SourceKind)> {
    let mut files: Vec<(String, SourceKind)> = fs::read_dir(dir())
        .expect("corpus dir")
        .filter_map(|e| {
            let name = e.ok()?.file_name().into_string().ok()?;
            let kind = SourceKind::from_extension(&format!(".{}", name.rsplit_once('.')?.1))?;
            Some((name, kind))
        })
        .collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

pub fn read(name: &str) -> String {
    fs::read_to_string(dir().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

pub fn lex_kind(text: &str, kind: SourceKind) -> Lexed {
    tokenize(
        text,
        "t",
        &Options {
            source_kind: Some(kind),
        },
    )
}

pub fn lex(text: &str) -> Lexed {
    tokenize(text, "t", &Options::default())
}
