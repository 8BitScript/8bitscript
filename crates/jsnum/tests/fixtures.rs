//! Every row of `fixtures.json` (made by `gen-fixtures.mjs` in Node).

use jsnum::{
    Nullable, cmp_utf16, fold_binop, number_to_string, object_key_order, to_int32, to_uint8,
    to_uint32, wrap_unsigned,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;

fn fixtures() -> Value {
    let text = include_str!("fixtures.json");
    serde_json::from_str(text).expect("fixtures.json parses")
}

fn num(v: &Value) -> f64 {
    v.as_str().expect("number string").parse().expect("f64")
}

fn opt_str(f: Option<f64>) -> Option<String> {
    f.map(|n| {
        let s = number_to_string(n);
        if n == 0.0 && n.is_sign_negative() {
            "-0".to_string()
        } else {
            s
        }
    })
}

fn rows(name: &str) -> Vec<Value> {
    fixtures()[name].as_array().expect("array").clone()
}

#[test]
fn number_conversions() {
    let table = rows("numbers");
    assert!(!table.is_empty());
    for row in &table {
        let n = num(&row["n"]);
        let label = row["n"].as_str().unwrap();
        assert_eq!(
            i64::from(to_int32(n)),
            row["int32"].as_i64().unwrap(),
            "int32 {label}"
        );
        assert_eq!(
            i64::from(to_uint32(n)),
            row["uint32"].as_i64().unwrap(),
            "uint32 {label}"
        );
        assert_eq!(
            i64::from(to_uint8(n)),
            row["uint8"].as_i64().unwrap(),
            "uint8 {label}"
        );
        assert_eq!(
            number_to_string(n),
            row["string"].as_str().unwrap(),
            "string {label}"
        );
    }
}

#[test]
fn utf16_compare() {
    let table = rows("cmp");
    assert!(!table.is_empty());
    for row in &table {
        let (a, b) = (row["a"].as_str().unwrap(), row["b"].as_str().unwrap());
        let want = match row["ord"].as_i64().unwrap() {
            -1 => Ordering::Less,
            0 => Ordering::Equal,
            _ => Ordering::Greater,
        };
        assert_eq!(cmp_utf16(a, b), want, "{a:?} vs {b:?}");
    }
}

#[test]
fn key_order() {
    for row in &rows("keyOrder") {
        let keys: Vec<&str> = row["keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap())
            .collect();
        let want: Vec<&str> = row["order"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap())
            .collect();
        let got: Vec<&str> = object_key_order(&keys)
            .into_iter()
            .map(|i| keys[i])
            .collect();
        assert_eq!(got, want, "{keys:?}");
    }
}

#[test]
fn fold_ops() {
    let table = rows("fold");
    assert!(!table.is_empty());
    for row in &table {
        let r = row.as_array().unwrap();
        let (op, ty) = (r[0].as_str().unwrap(), r[3].as_str().unwrap());
        let got = opt_str(fold_binop(op, num(&r[1]), num(&r[2]), ty));
        let want = r[4].as_str().map(str::to_string);
        assert_eq!(got, want, "{} {op} {} as {ty}", r[1], r[2]);
    }
}

#[test]
fn wrap_unsigned_rows() {
    let table = rows("wrap");
    assert!(!table.is_empty());
    for row in &table {
        let r = row.as_array().unwrap();
        let ty = r[1].as_str().unwrap();
        let got = opt_str(wrap_unsigned(num(&r[0]), ty));
        assert_eq!(got, r[2].as_str().map(str::to_string), "{} as {ty}", r[0]);
    }
}

#[test]
fn row_count_floor() {
    let f = fixtures();
    let total: usize = ["numbers", "cmp", "keyOrder", "fold", "wrap"]
        .iter()
        .map(|k| f[*k].as_array().unwrap().len())
        .sum();
    assert!(total > 10_000, "fixture rows: {total}");
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Probe {
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    x: Nullable<u32>,
}

#[test]
fn nullable_round_trip() {
    for (text, want) in [
        ("{}", Nullable::Absent),
        (r#"{"x":null}"#, Nullable::Null),
        (r#"{"x":7}"#, Nullable::Value(7)),
    ] {
        let probe: Probe = serde_json::from_str(text).unwrap();
        assert_eq!(probe.x, want);
        assert_eq!(serde_json::to_string(&probe).unwrap(), text);
    }
}

fn parse_f(s: &str) -> f64 {
    match s {
        "-0" => -0.0,
        other => other.parse().expect("f64"),
    }
}

#[test]
fn js_trim_and_whitespace() {
    for row in rows("trim") {
        let s = row[0].as_str().unwrap();
        assert_eq!(jsnum::js_trim(s), row[1].as_str().unwrap(), "trim {s:?}");
    }
    let expected: Vec<u32> = rows("ws")
        .iter()
        .map(|v| v.as_u64().unwrap() as u32)
        .collect();
    let got: Vec<u32> = (0..0x10000u32)
        .filter(|c| char::from_u32(*c).is_some_and(jsnum::is_js_whitespace))
        .collect();
    assert_eq!(got, expected);
}

#[test]
fn js_ws_class_matches() {
    let re = regex::Regex::new(&format!("^{}$", jsnum::JS_WS)).unwrap();
    for c in rows("ws") {
        let ch = char::from_u32(c.as_u64().unwrap() as u32).unwrap();
        assert!(re.is_match(&ch.to_string()), "{ch:?}");
    }
    assert!(!re.is_match("\u{85}"));
}

#[test]
fn utf16_len_rows() {
    for row in rows("utf16") {
        let s = row[0].as_str().unwrap();
        assert_eq!(
            jsnum::utf16_len(s) as u64,
            row[1].as_u64().unwrap(),
            "{s:?}"
        );
    }
}

#[test]
fn hex_upper_rows() {
    for row in rows("hex") {
        let (v, w) = (row[0].as_i64().unwrap(), row[1].as_u64().unwrap() as usize);
        assert_eq!(jsnum::hex_upper(v, w), row[2].as_str().unwrap(), "{v} {w}");
    }
    assert_eq!(jsnum::hex_upper(-5, 4), "00-5");
}

#[test]
fn parse_int_rows() {
    for row in rows("parseInt") {
        let d = row[0].as_str().unwrap();
        let r = row[1].as_u64().unwrap() as u32;
        let got = jsnum::parse_int(d, r);
        assert_eq!(
            number_to_string(got),
            number_to_string(parse_f(row[2].as_str().unwrap())),
            "{d} {r}"
        );
    }
}

/// Values from Node: `Number.parseInt(digits, radix)`.
#[test]
fn parse_int_long_and_partial_inputs() {
    let rows: [(&str, u32, &str); 15] = [
        (
            "1234567890123456789012345678901234567890",
            10,
            "1.2345678901234568e+39",
        ),
        (
            "1234567890abcdef1234567890abcdef12345678",
            16,
            "1.0392900530792776e+47",
        ),
        (
            "zz9876543210abcdefghijklmnopqrstuvwxyz12",
            36,
            "1.7858737402263953e+62",
        ),
        (
            "7777777777777777777777777777777777777777",
            8,
            "1.329227995784916e+36",
        ),
        ("1234567890123456789012345678901234567890", 8, "342391"),
        ("-12abc", 10, "-12"),
        ("+ff", 16, "255"),
        ("12z", 10, "12"),
        ("z", 10, "NaN"),
        (" 12", 10, "12"),
        ("\t\n -0x1f", 16, "-31"),
        ("0X1F", 16, "31"),
        ("0x1f", 10, "0"),
        (
            "13210321032103210321032103210321032103210",
            4,
            "2.289847728917121e+24",
        ),
        (
            "1v0123456789abcdefghijklmnopqrstuvabcdefg",
            32,
            "3.163711529383985e+60",
        ),
    ];
    for (d, r, want) in rows {
        assert_eq!(number_to_string(jsnum::parse_int(d, r)), want, "{d} {r}");
    }
}

#[test]
fn math_round_rows() {
    for row in rows("round") {
        let x = parse_f(row[0].as_str().unwrap());
        let want = parse_f(row[1].as_str().unwrap());
        let got = jsnum::math_round(x);
        assert!(
            got.to_bits() == want.to_bits() || (got.is_nan() && want.is_nan()),
            "round {x}: {got} vs {want}"
        );
    }
}
