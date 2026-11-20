//! Replays `fixtures/facts.json` (made by `gen/facts.mjs` in Node). Results
//! are compared as JSON text, so key order and number spelling count.

use fold::facts::{
    CONTROLLER_KINDS, FACTS, Json, LOGICAL_CONTROLS, PROGRAM_FACTS, controller_kind,
    fact_const_name, fact_placeholder, fact_problems, requires_problems, short_of_baseline,
    unmet_requirements,
};
use indexmap::IndexMap;
use serde::Serialize;

/// Any value as [`Json`], through its serde form.
fn to_value<T: Serialize>(v: &T) -> Json {
    Json::parse(&serde_json::to_string(v).unwrap()).unwrap()
}

fn list(items: Vec<Json>) -> Json {
    Json::Array(items)
}

/// The JS `undefined`/`null` argument, or an object, in the order written.
fn object(v: &Json) -> Option<IndexMap<String, Json>> {
    match v {
        Json::Null => None,
        Json::Object(map) => Some(map.clone()),
        other => panic!("{other:?}"),
    }
}

fn field<'a>(row: &'a Json, name: &str) -> &'a Json {
    let Json::Object(map) = row else {
        panic!("{row:?}")
    };
    &map[name]
}

#[test]
fn facts_match_js() {
    let fixture = Json::parse(include_str!("fixtures/facts.json")).unwrap();
    let Json::Array(rows) = &fixture else {
        panic!("rows")
    };
    let mut seen = std::collections::BTreeSet::new();
    for row in rows {
        let Json::String(fn_name) = field(row, "fn") else {
            panic!("fn")
        };
        let Json::Array(args) = field(row, "args") else {
            panic!("args")
        };
        let str_arg = |i: usize| match &args[i] {
            Json::String(s) => s.clone(),
            other => panic!("{other:?}"),
        };
        let got: Json = match fn_name.as_str() {
            "FACTS" => to_value(&FACTS.iter().collect::<Vec<_>>()),
            "LOGICAL_CONTROLS" => to_value(&LOGICAL_CONTROLS),
            "CONTROLLER_KINDS" => to_value(&CONTROLLER_KINDS),
            "PROGRAM_FACTS" => to_value(&*PROGRAM_FACTS),
            "factConstName" => to_value(&fact_const_name(&str_arg(0))),
            "factPlaceholder" => fact_placeholder(&str_arg(0)),
            "controllerKind" => match controller_kind(&args[0]) {
                Some(k) => Json::String(k.to_string()),
                None => Json::Null,
            },
            "requiresProblems" => list(
                requires_problems(object(&args[0]).as_ref())
                    .into_iter()
                    .map(Json::String)
                    .collect(),
            ),
            "unmetRequirements" => list(
                unmet_requirements(object(&args[0]).as_ref(), object(&args[1]).as_ref())
                    .iter()
                    .map(fold::facts::Unmet::to_json)
                    .collect(),
            ),
            "shortOfBaseline" => list(
                short_of_baseline(object(&args[0]).as_ref(), object(&args[1]).as_ref())
                    .iter()
                    .map(fold::facts::Short::to_json)
                    .collect(),
            ),
            "factProblems" => list(
                fact_problems(object(&args[0]).as_ref())
                    .into_iter()
                    .map(Json::String)
                    .collect(),
            ),
            other => panic!("unknown fn {other}"),
        };
        assert_eq!(
            got.stringify(),
            field(row, "result").stringify(),
            "{fn_name} {}",
            args.iter()
                .map(Json::stringify)
                .collect::<Vec<_>>()
                .join(" ")
        );
        seen.insert(fn_name.clone());
    }
    assert_eq!(seen.len(), 11, "{seen:?}");
    assert_eq!(FACTS.len(), 42);
}

#[test]
fn json_parse_and_stringify_follow_js() {
    let v =
        Json::parse(r#"{"b":1.0,"7":{},"a":[1.5,"x\"\n",null,true,1e21],"3":0,"b":2}"#).unwrap();
    assert_eq!(
        v.stringify(),
        r#"{"3":0,"7":{},"b":2,"a":[1.5,"x\"\n",null,true,1e+21]}"#
    );
    let big = Json::parse("[9007199254740992,1e400,-0]").unwrap();
    assert_eq!(big.stringify(), "[9007199254740992,null,0]");
    let lone = Json::parse(r#""a\ud800b😀""#).unwrap();
    assert_eq!(lone, Json::String("a\u{fffd}b\u{1f600}".to_string()));
    let deep = format!("{}1{}", "[".repeat(20_000), "]".repeat(20_000));
    assert!(Json::parse(&deep).is_ok());
    for bad in [
        "",
        "{",
        "[1,]",
        "{\"a\":1,}",
        "01",
        "1.",
        "\"\u{1}\"",
        "tru",
        "[1] x",
        "'a'",
    ] {
        assert!(Json::parse(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn nesting_the_parser_accepts_is_walked_without_recursion() {
    let depth = 100_000;
    let text = format!(
        r#"{{"name":"deep","x":{}1{}}}"#,
        "[".repeat(depth),
        "]".repeat(depth)
    );
    let value = Json::parse(&text).unwrap();
    let Json::Object(map) = &value else {
        panic!("object")
    };
    assert_eq!(map["name"], Json::String("deep".to_string()));
    let copy = value.clone();
    assert!(copy == value);
    assert_eq!(value.stringify().len(), text.len());
    drop(copy);
    drop(value);
}
