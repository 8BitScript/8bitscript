//! The wasm back end, ported from `packages/compiler/src/wasm`.

pub mod encode;
pub mod lower;

use std::fmt;

/// What the JS throws: `RangeError` from the encoder, `LowerError` from lowering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WasmError {
    Range(String),
    Lower(String),
}

impl WasmError {
    /// The JS error's `message`.
    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            Self::Range(m) | Self::Lower(m) => m,
        }
    }
}

impl fmt::Display for WasmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for WasmError {}
