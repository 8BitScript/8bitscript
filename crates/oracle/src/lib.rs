//! Stage dump format (canonical JSON, hex bytes, path tokens), the dump-dir
//! reader and the `compare` engine behind `cargo xtask compare`.

mod canon;
mod compare;
mod divergence;
mod tree;

pub use canon::{Roots, canonical_json, hex_dump, parse_hex, tokenize_path};
pub use compare::{Options, Report, compare};
pub use divergence::{Divergence, glob_match};
pub use tree::{DumpFile, read_tree};
