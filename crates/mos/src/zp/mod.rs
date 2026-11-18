//! Port of mos/zp/index.ts and mos/zp/frames.ts

use serde::{Deserialize, Serialize};

pub mod frames;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZpHole {
    /// Inclusive.
    pub start: i64,
    /// Exclusive.
    pub end: i64,
}
