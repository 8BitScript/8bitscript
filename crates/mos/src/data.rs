//! Port of mos/data.ts: string literals and const arrays laid out as labeled
//! bytes, appended to the end of the combined program.

use crate::asm::assemble::Directive;
use crate::types::storage_bytes;
use indexmap::IndexSet;
use jsnum::to_int32;
use serde::{Deserialize, Serialize};

/// One entry of the linked IR's string table.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IrString {
    pub text: String,
    pub bytes: Vec<i64>,
}

/// A const array global with everything the data section needs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataArrayGlobal {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub array: i64,
    pub init: Vec<i64>,
}

/// The label a string literal's data lands at, by its index in the string table.
#[must_use]
pub fn string_label(index: i64) -> String {
    format!("__8bs_str_{index}")
}

/// The label a const array global's data lands at.
#[must_use]
pub fn array_label(name: &str) -> String {
    format!("__8bs_arr_{name}")
}

fn byte_directive(values: Vec<i64>) -> Directive {
    Directive::Byte { values, prov: None }
}

/// String literals and const arrays, laid out as `label` / `.byte` pairs.
/// A string is length-prefixed. When `used_indexes` is given, a literal the
/// optimizer already folded into stores is omitted.
#[must_use]
pub fn build_data_section(
    strings: &[IrString],
    arrays: &[DataArrayGlobal],
    used_indexes: Option<&IndexSet<i64>>,
) -> Vec<Directive> {
    let mut out = Vec::new();
    for (index, s) in strings.iter().enumerate() {
        let index = index as i64;
        if used_indexes.is_some_and(|u| !u.contains(&index)) {
            continue;
        }
        out.push(Directive::Label {
            name: string_label(index),
            prov: None,
        });
        let mut values = vec![s.bytes.len() as i64];
        values.extend_from_slice(&s.bytes);
        out.push(byte_directive(values));
    }
    for array in arrays {
        let width = storage_bytes(Some(&array.type_name));
        let mut values = Vec::new();
        for &element in &array.init {
            let e = i64::from(to_int32(element as f64));
            values.push(e & 0xff);
            if width == 2 {
                values.push((e >> 8) & 0xff);
            }
        }
        out.push(Directive::Label {
            name: array_label(&array.name),
            prov: None,
        });
        out.push(byte_directive(values));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(bytes: &[i64]) -> IrString {
        IrString {
            text: String::new(),
            bytes: bytes.to_vec(),
        }
    }

    fn arr(name: &str, ty: &str, init: &[i64]) -> DataArrayGlobal {
        DataArrayGlobal {
            name: name.into(),
            type_name: ty.into(),
            array: init.len() as i64,
            init: init.to_vec(),
        }
    }

    fn bytes_of(d: &Directive) -> &[i64] {
        match d {
            Directive::Byte { values, .. } => values,
            _ => panic!("not a byte directive"),
        }
    }

    #[test]
    fn labels_are_named_by_index_and_name() {
        assert_eq!(string_label(3), "__8bs_str_3");
        assert_eq!(array_label("tbl"), "__8bs_arr_tbl");
    }

    #[test]
    fn strings_are_length_prefixed_and_filterable() {
        let strings = [s(&[72, 105]), s(&[]), s(&[33])];
        let all = build_data_section(&strings, &[], None);
        assert_eq!(all.len(), 6);
        assert_eq!(bytes_of(&all[1]), &[2, 72, 105]);
        assert_eq!(bytes_of(&all[3]), &[0]);
        let used: IndexSet<i64> = [2].into_iter().collect();
        let some = build_data_section(&strings, &[], Some(&used));
        assert_eq!(some.len(), 2);
        assert!(matches!(&some[0], Directive::Label { name, .. } if name == "__8bs_str_2"));
    }

    #[test]
    fn arrays_split_by_element_width() {
        let out = build_data_section(
            &[],
            &[
                arr("a", "utinyint", &[1, 300, -1]),
                arr("b", "usmallint", &[0x1234, 0xFFFF]),
                arr("c", "umediumint", &[0x123456]),
            ],
            None,
        );
        assert_eq!(bytes_of(&out[1]), &[1, 44, 255]);
        assert_eq!(bytes_of(&out[3]), &[0x34, 0x12, 0xFF, 0xFF]);
        // 24-bit elements are one byte each, as in the JS.
        assert_eq!(bytes_of(&out[5]), &[0x56]);
    }

    #[test]
    fn data_types_round_trip_through_json() {
        let a: DataArrayGlobal =
            serde_json::from_str(r#"{"name":"t","type":"u8","array":1,"init":[7]}"#).unwrap();
        assert_eq!(a, arr("t", "u8", &[7]));
    }
}
