//! Port of mos/chr-nes.ts

use serde::{Deserialize, Serialize};

/// A native source file: its tokenized path and its text (`chr-nes.ts:46`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeSource {
    pub path: String,
    pub text: String,
}
