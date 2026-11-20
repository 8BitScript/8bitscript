//! Replays `fixtures/facts.json` (made by `gen/facts.mjs` in Node).

use fold::facts::{
    CONTROLLER_KINDS, FACTS, Json, LOGICAL_CONTROLS, PROGRAM_FACTS, controller_kind,
    fact_const_name, fact_placeholder, fact_problems, requires_problems, short_of_baseline,
    unmet_requirements,
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Row {
    #[serde(rename = "fn")]
    name: String,
    args: Vec<Json>,
    result: Json,
}

/// Any value as [`Json`], so keys keep their order and numbers compare as f64.
fn to_value<T: Serialize>(v: &T) -> Json {
    serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

/// The JS `undefined`/`null` argument, or an object, in the order written.
fn object(v: &Json) -> Option<IndexMap<String, Json>> {
    match v {
        Json::Null => None,
        Json::Object(map) => Some(map.clone()),
        other => panic!("{other:?}"),
    }
}

#[test]
fn facts_match_js() {
    let rows: Vec<Row> = serde_json::from_str(include_str!("fixtures/facts.json")).unwrap();
    let mut seen = std::collections::BTreeMap::<String, usize>::new();
    for row in &rows {
        let fn_name = row.name.as_str();
        let args = &row.args;
        let str_arg = |i: usize| match &args[i] {
            Json::String(s) => s.clone(),
            other => panic!("{other:?}"),
        };
        let got: Json = match fn_name {
            "FACTS" => to_value(&FACTS.iter().collect::<Vec<_>>()),
            "LOGICAL_CONTROLS" => to_value(&LOGICAL_CONTROLS),
            "CONTROLLER_KINDS" => to_value(&CONTROLLER_KINDS),
            "PROGRAM_FACTS" => to_value(&*PROGRAM_FACTS),
            "factConstName" => to_value(&fact_const_name(&str_arg(0))),
            "factPlaceholder" => to_value(&fact_placeholder(&str_arg(0))),
            "controllerKind" => to_value(&controller_kind(&args[0])),
            "requiresProblems" => to_value(&requires_problems(object(&args[0]).as_ref())),
            "unmetRequirements" => to_value(&unmet_requirements(
                object(&args[0]).as_ref(),
                object(&args[1]).as_ref(),
            )),
            "shortOfBaseline" => to_value(&short_of_baseline(
                object(&args[0]).as_ref(),
                object(&args[1]).as_ref(),
            )),
            "factProblems" => to_value(&fact_problems(object(&args[0]).as_ref())),
            other => panic!("unknown fn {other}"),
        };
        assert_eq!(got, row.result, "{fn_name} {}", args[0].stringify());
        *seen.entry(fn_name.to_string()).or_default() += 1;
    }
    assert_eq!(seen.len(), 11, "{seen:?}");
    assert_eq!(FACTS.len(), 42);
}

#[test]
fn json_stringify_matches_js_forms() {
    let v: Json =
        serde_json::from_str(r#"{"b":1.0,"a":[1.5,"x\"\n",null,true,1e21],"7":{}}"#).unwrap();
    assert_eq!(
        v.stringify(),
        r#"{"7":{},"b":1,"a":[1.5,"x\"\n",null,true,1e+21]}"#
    );
}
