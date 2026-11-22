//! The linked program (`linked.json`): the `ir` literal of `link` (`linker/index.mjs:1279`)
//! plus what `link` adds after it (`functionsByOutput`, `instances`, `memory`).

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::program::{ChrPatch, Function, Global, IrString};

/// The linked program the backends read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkedProgram {
    pub chr_patches: Vec<ChrPatch>,
    pub entry: String,
    pub functions: Vec<Function>,
    /// A JS `Map` from output name to function, dumped as an object.
    pub functions_by_output: IndexMap<String, Function>,
    pub globals: Vec<Global>,
    /// Always empty in a linked program; kept as free-form values because this crate cannot
    /// depend on the module IR.
    pub imports: Vec<Value>,
    pub memory: Memory,
    pub native_sources: Vec<String>,
    pub strings: Vec<IrString>,
    /// Set once static instances are expanded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instances: Option<Vec<Instance>>,
}

/// `memoryOf`: declared RAM and constant data bytes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Memory {
    pub data: i64,
    pub variables: i64,
}

/// One instance of a stateful component and the bytes it takes (`--size`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Instance {
    pub component: String,
    pub instance: String,
    pub bytes: i64,
}

/// Reads a `linked.json` text.
///
/// # Errors
/// The parser's message for malformed JSON, an unknown field, a missing field or a wrong type.
pub fn parse_linked(text: &str) -> Result<LinkedProgram, String> {
    serde_json::from_str(text).map_err(|e| e.to_string())
}

/// Writes the canonical dump text for `program`.
///
/// # Errors
/// The serializer's message when a value cannot be represented.
pub fn to_canonical_linked(program: &LinkedProgram) -> Result<String, String> {
    let value = program
        .serialize(serde_json::value::Serializer)
        .map_err(|e| e.to_string())?;
    Ok(oracle::canonical_json(&value))
}

/// Parses `text`, writes it back and compares the bytes.
///
/// # Errors
/// A one-line description: the parse error, or the first line where the text differs.
pub fn roundtrip_linked(text: &str) -> Result<(), String> {
    let program = parse_linked(text)?;
    let again = to_canonical_linked(&program)?;
    crate::same_text(text, &again)
}
