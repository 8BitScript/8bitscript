//! Replays `fixtures/leaf.json` (made by `gen/optimize-leaf.mjs` in Node): the leaf passes of
//! `linker/optimize.mjs` over the statements and expressions of the corpus's linked IR.

use std::collections::BTreeMap;

use indexmap::IndexSet;
use mos_ir::{Expr, IrString, Stmt};
use optimize::{
    Ctx, always_returns, asm_names, binds_name, collect_assigned, collect_bound_names, const_value,
    contains_jump, contains_return, contains_string_byte, is_compile_time_arg, is_numeric_const,
    is_side_effect_free, match_counted_for, node_count, reduce_divide, reduce_modulo,
    reduce_multiply, references_names, string_bytes, wrap_unsigned,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn parse<T: DeserializeOwned>(value: &Value) -> T {
    serde_json::from_value(value.clone()).unwrap_or_else(|e| panic!("{e}: {value}"))
}

/// A JS number: an integer-valued result is an integer, NaN is `null`.
fn num(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9e15 {
        json!(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

fn optional_number(value: Option<f64>) -> Value {
    value.map_or(Value::Null, num)
}

fn optional_expr(value: Option<Expr>) -> Value {
    value.map_or(Value::Null, |e| serde_json::to_value(e).unwrap())
}

fn names(value: &Value) -> IndexSet<String> {
    parse::<Vec<String>>(value).into_iter().collect()
}

/// A set result, sorted: the fixture rows keep object keys sorted, so the JS insertion order
/// of a walk is not recoverable from them; membership is what the callers read.
fn set(out: &IndexSet<String>) -> Value {
    let mut items: Vec<_> = out.iter().collect();
    items.sort();
    json!(items)
}

fn sorted(value: &Value) -> Value {
    let mut items: Vec<Value> = value.as_array().cloned().unwrap_or_default();
    items.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    Value::Array(items)
}

fn run(row: &Value) -> Value {
    let args = &row["args"];
    match row["fn"].as_str().unwrap() {
        "collectAssigned" => {
            let mut out = IndexSet::new();
            collect_assigned(&parse::<Stmt>(&args[0]), &mut out);
            set(&out)
        }
        "collectBoundNames" => {
            let mut out = IndexSet::new();
            collect_bound_names(&parse::<Stmt>(&args[0]), &mut out);
            set(&out)
        }
        "containsStringByte" => json!(contains_string_byte(&parse::<Stmt>(&args[0]))),
        "nodeCount" => json!(node_count(&parse::<Stmt>(&args[0]))),
        "containsJump" => json!(contains_jump(&parse::<Stmt>(&args[0]))),
        "containsReturn" => json!(contains_return(&parse::<Stmt>(&args[0]))),
        "alwaysReturns" => json!(always_returns(&parse::<Stmt>(&args[0]))),
        "isNumericConst" => json!(is_numeric_const(&parse::<Expr>(&args[0]))),
        "isCompileTimeArg" => json!(is_compile_time_arg(&parse::<Expr>(&args[0]))),
        "isSideEffectFree" => json!(is_side_effect_free(&parse::<Expr>(&args[0]))),
        "constValue" => optional_number(const_value(&parse::<Expr>(&args[0]))),
        "reduceMultiply" | "reduceDivide" | "reduceModulo" => {
            let Expr::Binop(binop) = parse::<Expr>(&args[0]) else {
                panic!("not a binop: {}", args[0]);
            };
            optional_expr(match row["fn"].as_str().unwrap() {
                "reduceMultiply" => reduce_multiply(&binop),
                "reduceDivide" => reduce_divide(&binop),
                _ => reduce_modulo(&binop),
            })
        }
        "wrapUnsigned" => {
            optional_number(wrap_unsigned(args[0].as_f64().unwrap(), args[1].as_str()))
        }
        "stringBytes" => {
            let ctx = Ctx {
                strings: parse::<Vec<IrString>>(&args[1]["strings"]),
                ..Ctx::default()
            };
            string_bytes(&parse::<Expr>(&args[0]), &ctx).map_or(Value::Null, |bytes| json!(bytes))
        }
        "referencesNames" => json!(references_names(&parse::<Stmt>(&args[0]), &names(&args[1]))),
        "asmNames" => {
            let Stmt::Asm(asm) = parse::<Stmt>(&args[0]) else {
                panic!("not an asm block: {}", args[0]);
            };
            json!(asm_names(&asm, &names(&args[1])))
        }
        "bindsName" => json!(binds_name(
            &parse::<Stmt>(&args[0]),
            args[1].as_str().unwrap()
        )),
        "matchCountedFor" => {
            let Stmt::For(statement) = parse::<Stmt>(&args[0]) else {
                panic!("not a for: {}", args[0]);
            };
            match_counted_for(&statement, args[1].as_f64().unwrap()).map_or(
                Value::Null,
                |m| json!({"name": m.name, "count": num(m.count), "type": m.ty}),
            )
        }
        other => panic!("unknown function {other}"),
    }
}

fn rows() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/leaf.json")).expect("fixtures parse")
}

#[test]
fn every_row_matches_js() {
    let rows = rows();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for row in &rows {
        let got = run(row);
        let want = match row["fn"].as_str().unwrap() {
            "collectAssigned" | "collectBoundNames" => sorted(&row["result"]),
            _ => row["result"].clone(),
        };
        assert_eq!(got, want, "{}: {}", row["fn"], row["args"]);
        *counts
            .entry(row["fn"].as_str().unwrap().to_string())
            .or_default() += 1;
    }
    for name in [
        "collectAssigned",
        "collectBoundNames",
        "containsStringByte",
        "nodeCount",
        "containsJump",
        "containsReturn",
        "alwaysReturns",
        "isNumericConst",
        "isCompileTimeArg",
        "isSideEffectFree",
        "constValue",
        "reduceMultiply",
        "reduceDivide",
        "reduceModulo",
        "wrapUnsigned",
        "stringBytes",
        "referencesNames",
        "asmNames",
        "bindsName",
        "matchCountedFor",
    ] {
        assert!(
            counts.get(name).copied().unwrap_or(0) > 0,
            "no rows for {name}"
        );
    }
}

#[test]
fn a_divide_by_zero_is_not_folded() {
    let expr: Expr = parse(&json!({
        "kind": "binop", "operator": "/", "type": "utinyint",
        "left": {"kind": "const", "value": 4, "type": "utinyint"},
        "right": {"kind": "const", "value": 0, "type": "utinyint"},
    }));
    assert_eq!(const_value(&expr), None);
}
