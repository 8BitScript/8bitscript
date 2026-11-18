//! Stage dump format (canonical JSON, hex bytes, path tokens), the dump-dir
//! reader and the `compare` engine behind `cargo xtask compare`.

mod canon;
mod compare;
mod divergence;
mod tree;

pub use canon::{canonical_json, hex_dump, parse_hex, tokenize_path, Roots};
pub use compare::{compare, Options, Report};
pub use divergence::{glob_match, Divergence};
pub use tree::{read_tree, DumpFile};
