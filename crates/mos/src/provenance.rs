//! Port of mos/provenance.ts

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSpan {
    pub file: String,
    pub start: i64,
    pub length: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Generated {
    pub reason: String,
}

/// `source`..`instance` serialize `None` as `null`; `generated` is skipped.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provenance {
    pub source: Option<SourceSpan>,
    pub function: Option<String>,
    pub origin: Option<String>,
    pub component: Option<String>,
    pub instance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated: Option<Generated>,
}

pub const NO_PROVENANCE: Provenance = Provenance {
    source: None,
    function: None,
    origin: None,
    component: None,
    instance: None,
    generated: None,
};
