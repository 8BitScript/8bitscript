//! The const passes against the JS oracle (`gen/linker-scope.mjs` writes the golden files), and
//! the paths that stop at the rewrite stub.

mod common;

use common::{
    TREES, assert_rows, complete_call_rows, const_rows, facts_json, prepare, visible_json,
};
use diagnostics::Severity;
use indexmap::IndexMap;
use linker::consts::{
    Callee, complete_call, const_expression, resolve_initialiser, resolve_pending_consts,
};
use linker::imports::rewrite_array_access;
use linker::scope::Scope;
use linker::{ConstValue, Unported};
use mos_ir::{Call, Const, Expr, Param, Ref};

#[test]
fn tested_facts_match() {
    for tree in TREES {
        let l = common::load(tree);
        assert_eq!(l.text(facts_json(&l)), l.golden("facts.json"), "{tree}");
    }
}

#[test]
fn visible_consts_match() {
    for tree in TREES {
        let (l, _) = prepare(tree);
        assert_eq!(l.text(visible_json(&l)), l.golden("visible.json"), "{tree}");
    }
}

#[test]
fn const_expressions_and_string_fits_match() {
    for tree in TREES {
        let (l, _) = prepare(tree);
        assert_rows(&l, &const_rows(&l), &["constExpression", "checkStringFits"]);
    }
}

#[test]
fn complete_calls_match() {
    for tree in TREES {
        let (l, renamed) = prepare(tree);
        if renamed {
            assert_rows(&l, &complete_call_rows(&l), &["completeCall"]);
        } else {
            assert!(
                l.golden_rows("completeCall") == l.text(serde_json::json!([])),
                "{tree}"
            );
        }
    }
}

#[test]
fn a_pending_const_stops_at_the_rewrite_stub() {
    let (mut l, renamed) = prepare("consts");
    assert!(renamed);
    let mut diagnostics = Vec::new();
    let result = resolve_pending_consts(&l.graph, &mut l.sides, &mut diagnostics);
    assert_eq!(result, Err(Unported));
}

#[test]
fn no_pending_const_needs_no_rewrite() {
    let (mut l, renamed) = prepare("strings");
    assert!(!renamed); // the 6-char literal is an error, so the names were never assigned
    let mut diagnostics = Vec::new();
    assert_eq!(
        resolve_pending_consts(&l.graph, &mut l.sides, &mut diagnostics),
        Ok(())
    );
    assert!(diagnostics.is_empty());
}

fn reference(name: &str) -> Expr {
    Expr::Ref(Ref {
        name: name.to_string(),
        ty: jsnum::Nullable::Absent,
        start: Some(3),
        length: Some(4),
    })
}

#[test]
fn an_initialiser_naming_a_string_const_is_refused() {
    let (mut l, _) = prepare("consts");
    let mut diagnostics = Vec::new();
    let scope = Scope::default();
    // `GREETING` is a string const of module 0.
    let mut expr = reference("GREETING");
    let got = resolve_initialiser(
        &mut expr,
        "utinyint",
        &scope,
        0,
        &mut l.sides,
        &l.graph,
        &mut diagnostics,
    );
    assert_eq!(got, Ok(0.0));
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(
        diagnostics[0].message,
        "'GREETING' is a string const; it cannot initialize a utinyint"
    );
    assert_eq!((diagnostics[0].start, diagnostics[0].length), (3, 4));
}

#[test]
fn an_initialiser_naming_nothing_is_unresolved() {
    let (mut l, _) = prepare("consts");
    let mut diagnostics = Vec::new();
    let mut expr = reference("nope");
    let got = resolve_initialiser(
        &mut expr,
        "utinyint",
        &Scope::default(),
        0,
        &mut l.sides,
        &l.graph,
        &mut diagnostics,
    );
    assert_eq!(got, Ok(0.0));
    assert_eq!(diagnostics[0].message, "cannot find name 'nope'");
    // The same name bound in the scope is a name that is not a const.
    let mut diagnostics = Vec::new();
    let mut scope = Scope::default();
    linker::scope::bind_local(&mut scope, "nope");
    let mut expr = reference("nope");
    let got = resolve_initialiser(
        &mut expr,
        "utinyint",
        &scope,
        0,
        &mut l.sides,
        &l.graph,
        &mut diagnostics,
    );
    assert_eq!(got, Ok(0.0));
    assert!(
        diagnostics[0]
            .message
            .contains("is not a const, so it cannot initialize a global")
    );
}

#[test]
fn a_const_initialiser_reaches_the_rewrite_stub() {
    let (mut l, _) = prepare("consts");
    let mut diagnostics = Vec::new();
    let mut expr = reference("LIMIT");
    let got = resolve_initialiser(
        &mut expr,
        "utinyint",
        &Scope::default(),
        0,
        &mut l.sides,
        &l.graph,
        &mut diagnostics,
    );
    assert_eq!(got, Err(Unported));
}

#[test]
fn array_access_reaches_the_rewrite_stub() {
    let (mut l, _) = prepare("imports");
    let mut diagnostics = Vec::new();
    let mut array = reference("a");
    let mut index = Expr::Const(Const { value: 0, ty: None });
    let mut element = None;
    let got = rewrite_array_access(
        &mut array,
        &mut index,
        &mut element,
        &Scope::default(),
        0,
        &mut l.sides,
        &l.graph,
        &mut diagnostics,
        false,
    );
    assert_eq!(got, Err(Unported));
}

#[test]
fn a_pending_const_has_no_expression_yet() {
    let pending = ConstValue::Pending {
        pending: Box::new(reference("X")),
        ty: "utinyint".to_string(),
    };
    assert_eq!(const_expression(&pending, Some("utinyint")), None);
    assert_eq!(
        const_expression(&ConstValue::Number(5.0), None),
        Some(Expr::Const(Const { value: 5, ty: None }))
    );
}

fn param(name: &str, default: Option<i64>) -> Param {
    Param {
        name: name.to_string(),
        ty: "utinyint".to_string(),
        default: default.map(|value| Expr::Const(Const { value, ty: None })),
        element_type: None,
        length: None,
    }
}

fn call(args: usize) -> Call {
    Call {
        name: "f".to_string(),
        args: (0..args)
            .map(|i| {
                Expr::Const(Const {
                    value: i as i64,
                    ty: None,
                })
            })
            .collect(),
        ty: jsnum::Nullable::Null,
        start: Some(10),
        length: Some(2),
        instance: None,
    }
}

#[test]
fn a_call_is_filled_from_the_defaults_and_typed() {
    let mut callees = IndexMap::new();
    callees.insert(
        "f".to_string(),
        Callee {
            params: vec![param("a", None), param("b", Some(7)), param("c", Some(8))],
            return_type: "utinyint".to_string(),
        },
    );
    let mut c = call(1);
    let mut found = Vec::new();
    complete_call(&mut c, None, Some(&callees), "x.8bs", &mut found);
    assert!(found.is_empty());
    assert_eq!(c.args.len(), 3);
    assert_eq!(c.ty, jsnum::Nullable::Value("utinyint".to_string()));

    // Too few and too many, with and without the source name.
    for (n, original, want) in [
        (0, None, "'f' takes 1 to 3 arguments, not 0"),
        (4, Some("g"), "'g' takes 1 to 3 arguments, not 4"),
    ] {
        let mut c = call(n);
        let mut found = Vec::new();
        complete_call(&mut c, original, Some(&callees), "x.8bs", &mut found);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].message, want);
        assert_eq!(found[0].severity, Severity::Error);
        assert_eq!((found[0].start, found[0].length), (10, 2));
    }

    // One parameter, no default: the singular.
    let mut one = IndexMap::new();
    one.insert(
        "f".to_string(),
        Callee {
            params: vec![param("a", None)],
            return_type: "void".to_string(),
        },
    );
    let mut c = call(2);
    let mut found = Vec::new();
    complete_call(&mut c, None, Some(&one), "x.8bs", &mut found);
    assert_eq!(found[0].message, "'f' takes 1 argument, not 2");
    // A void callee leaves the type alone; a callee that is not there changes nothing.
    let mut c = call(1);
    let mut found = Vec::new();
    complete_call(&mut c, None, Some(&one), "x.8bs", &mut found);
    assert_eq!(c.ty, jsnum::Nullable::Null);
    complete_call(&mut c, None, None, "x.8bs", &mut found);
    assert!(found.is_empty());
}
