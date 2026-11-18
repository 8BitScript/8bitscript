//! Diagnostics and source-kind helpers (port spec P3-02):
//! `diagnostics/index.mjs` and `source/index.mjs`.

pub mod codes;
mod diagnostic;
mod source;

pub use diagnostic::{Diagnostic, Position, Severity, diagnostic, position_at};
pub use source::{
    CPU_FAMILY, MACHINES, SOURCE_EXTENSIONS, cpu_family, is_locale_name, is_source_file,
    source_kind_of, strip_source_extension,
};
