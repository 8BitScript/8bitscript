//! Port of mos/asm/assemble.ts (types)

use super::encode::AddressingMode;
use crate::provenance::Provenance;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// Which byte of a label's address an operand takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Half {
    Lo,
    Hi,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Operand {
    Value {
        value: i64,
    },
    Label {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        byte: Option<Half>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset: Option<i64>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Directive {
    Label {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prov: Option<Provenance>,
    },
    Instruction {
        mnemonic: String,
        mode: AddressingMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        operand: Option<Operand>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prov: Option<Provenance>,
    },
    Byte {
        values: Vec<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prov: Option<Provenance>,
    },
    Equate {
        name: String,
        value: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prov: Option<Provenance>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListingLine {
    pub address: i64,
    pub bytes: Vec<i64>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prov: Option<Provenance>,
}

/// A successful assembly (`AssembleResult` with `ok: true`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Assembled {
    pub bytes: Vec<u8>,
    pub listing: Vec<ListingLine>,
    pub labels: IndexMap<String, i64>,
}
