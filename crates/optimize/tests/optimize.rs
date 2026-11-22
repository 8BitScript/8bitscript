//! Replays `fixtures/optimize.json` (made by `gen/optimize.mjs` in Node): the constant folder, the
//! evaluator and the inlining passes of `linker/optimize.mjs` over small synthetic programs and
//! the smallest linked programs of the corpus. The programs are in `fixtures/optimize-programs.json`.
//!
//! A pass that reaches the statement optimizer (`optimize_statement`, not yet ported) answers
//! `Unported`; those rows are skipped and counted by name in `BLOCKED`, so the number is fixed
//! and shrinks when the statement optimizer lands.
//!
//! A JS `null` and an absent field mean the same in the IR, so both sides are compared with their
//! null object fields removed.

use std::collections::BTreeMap;

use indexmap::{IndexMap, IndexSet};
use mos_ir::walk::{Flow, Node, visit_expr};
use mos_ir::{Call, Expr, Function, IrString, Stmt};
use optimize::{
    Ctx, Eval, Unported, bound_names, collect_names, const_eval_call, contains_kind,
    count_calls_in, count_returns, eval_block, eval_expr, eval_stmt, find_value_call, fold_expr,
    forward_call, forward_expr_call, forwarded_call, fresh_name, hoist_value_call,
    inline_single_caller, inline_void_call, optimize_body, propagate_const_locals, reachable_has,
    rename_bound, replace_node, rest_is_inert, single_caller_callee, site_body, site_count,
    substitute_bindings, writes_of,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

fn parse<T: DeserializeOwned>(value: &Value) -> T {
    serde_json::from_value(value.clone()).unwrap_or_else(|e| panic!("{e}: {value}"))
}

fn to<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

/// A JS number: an integer-valued result is an integer, NaN is `null`.
fn num(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9e15 {
        json!(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

fn opt_num(value: Option<f64>) -> Value {
    value.map_or(Value::Null, num)
}

/// A call node as the JS has it: with its `kind`.
fn call_json(call: &Call) -> Value {
    to(&Expr::Call(call.clone()))
}

fn strip_nulls(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(strip_nulls).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k.clone(), strip_nulls(v)))
                .collect::<Map<_, _>>(),
        ),
        other => other.clone(),
    }
}

struct Prog {
    functions: Vec<Function>,
    strings: Vec<IrString>,
    addressed: Vec<String>,
    taken: Vec<String>,
}

fn programs() -> Vec<Prog> {
    let all: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/optimize-programs.json")).expect("programs");
    all.iter()
        .map(|p| Prog {
            functions: parse(&p["functions"]),
            strings: parse(&p["strings"]),
            addressed: parse(&p["addressed"]),
            taken: parse(&p["taken"]),
        })
        .collect()
}

fn names(value: &Value) -> IndexSet<String> {
    parse::<Vec<String>>(value).into_iter().collect()
}

fn make_ctx(p: &Prog, spec: &Value) -> Ctx {
    Ctx {
        functions_by_name: p
            .functions
            .iter()
            .enumerate()
            .map(|(i, f)| (f.name.clone(), i))
            .collect(),
        strings: p.strings.clone(),
        inlining: names(&spec["inlining"]),
        unrolling_string_copy: spec["unrolling"].as_bool().unwrap(),
        taken: p.taken.iter().cloned().collect(),
        caller_bound: names(&spec["callerBound"]),
        zp_names: names(&spec["zpNames"]),
        current_fn: spec["currentFn"].as_str().map(str::to_string),
        remarks: Vec::new(),
        consumed: names(&spec["consumed"]),
        retired: names(&spec["retired"]),
        addressed: p.addressed.iter().cloned().collect(),
    }
}

fn sorted_set(set: &IndexSet<String>) -> Value {
    let mut items: Vec<&String> = set.iter().collect();
    items.sort();
    json!(items)
}

fn state(ctx: &Ctx) -> Value {
    json!({
        "inlining": sorted_set(&ctx.inlining),
        "taken": sorted_set(&ctx.taken),
        "zpNames": sorted_set(&ctx.zp_names),
        "consumed": sorted_set(&ctx.consumed),
        "retired": sorted_set(&ctx.retired),
    })
}

fn with_state(ctx: &Ctx, out: Value) -> Value {
    json!({"out": out, "state": state(ctx)})
}

fn children(stmt: &Stmt) -> Vec<&Stmt> {
    match stmt {
        Stmt::Block(s) => s.body.iter().collect(),
        Stmt::While(s) => s.body.iter().collect(),
        Stmt::For(s) => s.body.iter().collect(),
        Stmt::If(s) => s.then.iter().chain(s.r#else.iter().flatten()).collect(),
        _ => Vec::new(),
    }
}

fn stmt_at<'a>(p: &'a Prog, path: &Value) -> (&'a Function, &'a Stmt) {
    let path: Vec<usize> = parse(path);
    let f = &p.functions[path[0]];
    let mut cur = &f.body[path[1]];
    for &i in &path[2..] {
        cur = children(cur)[i];
    }
    (f, cur)
}

/// A statement's own expressions that the evaluator rows address.
fn own_exprs(stmt: &Stmt) -> Vec<&Expr> {
    match stmt {
        Stmt::Assign(s) => vec![&s.value],
        Stmt::Local(s) => vec![&s.init],
        Stmt::Return(s) => s.value.iter().collect(),
        _ => Vec::new(),
    }
}

/// The calls of a statement's own expressions, outermost first.
fn own_calls(stmt: &Stmt) -> Vec<&Call> {
    let mut exprs: Vec<&Expr> = Vec::new();
    match stmt {
        Stmt::Assign(s) => exprs.push(&s.value),
        Stmt::Local(s) => exprs.push(&s.init),
        Stmt::Return(s) => exprs.extend(s.value.iter()),
        Stmt::Call(s) => exprs.extend(s.args.iter()),
        Stmt::NamespaceCall(s) => exprs.extend(s.args.iter()),
        Stmt::MemoryRead(s) => exprs.push(&s.address),
        Stmt::MemoryWrite(s) => exprs.extend([&s.address, &s.value]),
        Stmt::StoreIndex(s) => exprs.extend([&s.array, &s.index, &s.value]),
        Stmt::If(s) => exprs.push(&s.test),
        Stmt::While(s) => exprs.push(&s.test),
        Stmt::For(s) => {
            if let Some(init) = s.init.as_option() {
                exprs.extend(own_exprs(init));
            }
            exprs.extend(s.test.as_option());
            if let Some(update) = s.update.as_option() {
                exprs.extend(own_exprs(update));
            }
        }
        Stmt::StringCopy(s) => exprs.extend([&s.target, &s.source]),
        _ => {}
    }
    let mut out = Vec::new();
    for expr in exprs {
        visit_expr(expr, &mut |node| {
            if let Node::Expr(Expr::Call(call)) = node {
                out.push(call);
            }
            Flow::Continue
        });
    }
    out
}

fn call_of<'a>(stmt: &'a Stmt, k: &Value) -> &'a Call {
    match k.as_u64() {
        None => match stmt {
            Stmt::Call(call) => call,
            _ => panic!("no own call"),
        },
        Some(k) => own_calls(stmt)[k as usize],
    }
}

fn eval_json(result: Eval) -> Value {
    match result {
        Eval::Abort => json!("abort"),
        Eval::Fell => json!({"returned": false, "value": null}),
        Eval::Returned(value) => json!({"returned": true, "value": num(value)}),
    }
}

fn env_of(value: &Value) -> IndexMap<String, f64> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry[0].as_str().unwrap().to_string(),
                entry[1].as_f64().unwrap(),
            )
        })
        .collect()
}

fn env_json(env: &IndexMap<String, f64>) -> Value {
    Value::Array(env.iter().map(|(k, v)| json!([k, num(*v)])).collect())
}

fn stmts_json(list: &[Stmt]) -> Value {
    to(&list)
}

fn node_test(label: &str) -> impl Fn(Node<'_>) -> bool + '_ {
    move |node| match label {
        "store" => matches!(
            node,
            Node::Stmt(Stmt::StoreIndex(_) | Stmt::MemoryWrite(_) | Stmt::StringCopy(_))
        ),
        "asm" => matches!(node, Node::Stmt(Stmt::Asm(_))),
        "return" => matches!(node, Node::Stmt(Stmt::Return(_))),
        "call" => node.as_call().is_some(),
        other => panic!("unknown test {other}"),
    }
}

/// One row's answer, or `None` when the pass needed a function a later unit ports.
fn run(row: &Value, progs: &[Prog]) -> Option<Value> {
    let args = &row["args"];
    let name = row["fn"].as_str().unwrap();
    if name == "freshName" {
        let mut taken = names(&args["taken"]);
        let out = fresh_name(args["name"].as_str().unwrap(), &mut taken);
        return Some(json!({"out": out, "taken": taken.iter().collect::<Vec<_>>()}));
    }
    let p = &progs[args["p"].as_u64().unwrap() as usize];
    let fns = p.functions.as_slice();
    let ctx_arg = &args["ctx"];
    let by_name = |n: &str| fns.iter().find(|f| f.name == n);
    let blocked = |r: Result<Value, Unported>| r.ok();
    if let Some(fi) = args["f"].as_u64() {
        let f = &fns[fi as usize];
        return match name {
            "forwardedCall" => Some(forwarded_call(f).map_or(Value::Null, |w| {
                let mut used: Vec<&String> = w.used.iter().collect();
                used.sort();
                json!({"wrapped": call_json(w.wrapped), "constants": w.constants, "used": used})
            })),
            "boundNames" => Some(sorted_set(&bound_names(f))),
            "writesOf" => Some(sorted_set(&writes_of(f, &make_ctx(p, ctx_arg), fns))),
            "reachableHas" => {
                let label = args["test"].as_str().unwrap();
                let mut test = node_test(label);
                Some(json!(reachable_has(
                    f,
                    &make_ctx(p, ctx_arg),
                    fns,
                    &mut test
                )))
            }
            "siteCount" => Some(json!(site_count(
                args["name"].as_str().unwrap(),
                &make_ctx(p, ctx_arg),
                fns,
                &mut IndexSet::new()
            ))),
            "optimizeBody" => {
                let mut ctx = make_ctx(p, ctx_arg);
                blocked(optimize_body(&f.body, &mut ctx, fns).map(|out| stmts_json(&out)))
            }
            "propagateConstLocals" => {
                let mut ctx = make_ctx(
                    p,
                    &json!({
                        "inlining": [], "unrolling": false, "callerBound": [], "zpNames": [],
                        "currentFn": null, "consumed": [], "retired": []
                    }),
                );
                blocked(
                    propagate_const_locals(f.body.clone(), &mut ctx, fns)
                        .map(|out| stmts_json(&out)),
                )
            }
            "countCallsIn" => Some(json!(count_calls_in(
                &f.body,
                args["name"].as_str().unwrap()
            ))),
            "evalBlock" => {
                let mut env = env_of(&args["env"]);
                let mut ctx = make_ctx(p, ctx_arg);
                blocked(
                    eval_block(&f.body, &mut env, &mut ctx, fns)
                        .map(|res| json!({"res": eval_json(res), "env": env_json(&env)})),
                )
            }
            other => panic!("unknown function {other}"),
        };
    }
    let (f, stmt) = stmt_at(p, &args["path"]);
    let _ = f;
    let one = std::slice::from_ref(stmt);
    match name {
        "containsKind" => Some(json!(contains_kind(one, args["kind"].as_str().unwrap()))),
        "countReturns" => Some(json!(count_returns(one))),
        "collectNames" => {
            let mut out = IndexSet::new();
            collect_names(one, &mut out);
            Some(sorted_set(&out))
        }
        "renameBound" => {
            let renames: IndexMap<String, String> = args["renames"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| {
                    (
                        e[0].as_str().unwrap().to_string(),
                        e[1].as_str().unwrap().to_string(),
                    )
                })
                .collect();
            Some(stmts_json(&rename_bound(one, &renames)))
        }
        "substituteBindings" => {
            let bindings: IndexMap<String, Expr> = args["bindings"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| (e[0].as_str().unwrap().to_string(), parse::<Expr>(&e[1])))
                .collect();
            Some(stmts_json(&substitute_bindings(one, &bindings)))
        }
        "hoistValueCall" => {
            let mut ctx = make_ctx(p, ctx_arg);
            let out = hoist_value_call(stmt, &mut ctx, fns).ok()?;
            Some(with_state(
                &ctx,
                out.map_or(Value::Null, |l| stmts_json(&l)),
            ))
        }
        "findValueCall" => {
            let ctx = make_ctx(p, ctx_arg);
            Some(
                find_value_call(stmt, &ctx, fns).map_or(Value::Null, |found| {
                    let k = own_calls(stmt)
                        .iter()
                        .position(|c| std::ptr::eq(*c, found))
                        .expect("found call is one of the statement's own");
                    json!({"k": k})
                }),
            )
        }
        "inlineVoidCall" => {
            let Stmt::Call(call) = stmt else {
                panic!("not a call statement")
            };
            let mut ctx = make_ctx(p, ctx_arg);
            let out = inline_void_call(call, &mut ctx, fns).ok()?;
            Some(with_state(
                &ctx,
                out.map_or(Value::Null, |l| stmts_json(&l)),
            ))
        }
        "evalStmt" => {
            let mut env = env_of(&args["env"]);
            let mut ctx = make_ctx(p, ctx_arg);
            blocked(
                eval_stmt(stmt, &mut env, &mut ctx, fns)
                    .map(|res| json!({"res": eval_json(res), "env": env_json(&env)})),
            )
        }
        "evalExpr" => {
            let env = env_of(&args["env"]);
            let mut ctx = make_ctx(p, ctx_arg);
            let expr = own_exprs(stmt)[args["x"].as_u64().unwrap() as usize];
            blocked(eval_expr(expr, &env, &mut ctx, fns).map(opt_num))
        }
        "replaceNode" => {
            let call = call_of(stmt, &args["k"]);
            let with: Expr = parse(&json!({"kind": "const", "value": 9, "type": "utinyint"}));
            Some(to(&replace_node(stmt, call, &with)))
        }
        _ => {
            let call = call_of(stmt, &args["k"]);
            let callee = by_name(&call.name);
            let mut ctx = make_ctx(p, ctx_arg);
            match name {
                "singleCallerCallee" => Some(
                    single_caller_callee(call, &ctx, fns, args["wantValue"].as_bool().unwrap())
                        .map_or(Value::Null, |f| json!(f.name)),
                ),
                "constEvalCall" => blocked(const_eval_call(call, &mut ctx, fns).map(opt_num)),
                "foldExpr" => {
                    let out = fold_expr(&Expr::Call(call.clone()), &mut ctx, fns).ok()?;
                    Some(with_state(&ctx, to(&out)))
                }
                "forwardExprCall" => {
                    let out = forward_expr_call(call, &mut ctx, fns).ok()?;
                    Some(with_state(&ctx, out.map_or(Value::Null, |e| to(&e))))
                }
                "restIsInert" => Some(callee.map_or(Value::Null, |callee| {
                    json!(rest_is_inert(stmt, call, callee, &ctx, fns))
                })),
                "siteBody" => {
                    let site = site_body(call, callee.unwrap(), &mut ctx, fns);
                    let out = site.map_or(Value::Null, |s| {
                        let mut free: Vec<&String> = s.free.iter().collect();
                        free.sort();
                        json!({
                            "statements": stmts_json(&s.statements),
                            "returned": s.returned.as_ref().map_or(Value::Null, to),
                            "locals": s.locals.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
                            "free": free,
                        })
                    });
                    Some(with_state(&ctx, out))
                }
                "inlineSingleCaller" => {
                    let out = inline_single_caller(call, callee.unwrap(), &mut ctx, fns).ok()?;
                    Some(with_state(
                        &ctx,
                        out.map_or(Value::Null, |l| stmts_json(&l)),
                    ))
                }
                "forwardCall" => {
                    let callee = callee.unwrap();
                    let forwarded = forwarded_call(callee).expect("a forwarder");
                    Some(
                        forward_call(call, callee, &forwarded, &ctx, fns)
                            .map_or(Value::Null, |c| call_json(&c)),
                    )
                }
                other => panic!("unknown function {other}"),
            }
        }
    }
}

/// Rows whose pass reaches the statement optimizer, which a later unit ports.
const BLOCKED: &[(&str, usize)] = &[
    ("hoistValueCall", 13),
    ("inlineSingleCaller", 405),
    ("inlineVoidCall", 70),
    ("optimizeBody", 358),
];

const EXPECTED: &[(&str, usize)] = &[
    ("boundNames", 141),
    ("collectNames", 341),
    ("constEvalCall", 600),
    ("containsKind", 600),
    ("countCallsIn", 259),
    ("countReturns", 341),
    ("evalBlock", 236),
    ("evalExpr", 234),
    ("evalStmt", 578),
    ("findValueCall", 600),
    ("foldExpr", 303),
    ("forwardCall", 135),
    ("forwardExprCall", 303),
    ("forwardedCall", 141),
    ("freshName", 12),
    ("hoistValueCall", 600),
    ("inlineSingleCaller", 450),
    ("inlineVoidCall", 290),
    ("optimizeBody", 393),
    ("propagateConstLocals", 141),
    ("reachableHas", 600),
    ("renameBound", 288),
    ("replaceNode", 57),
    ("restIsInert", 303),
    ("singleCallerCallee", 600),
    ("siteBody", 600),
    ("siteCount", 393),
    ("substituteBindings", 474),
    ("writesOf", 393),
];

#[test]
fn every_row_matches_js() {
    let progs = programs();
    let rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/optimize.json")).expect("fixtures parse");
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut blocked: BTreeMap<String, usize> = BTreeMap::new();
    for row in &rows {
        let fn_name = row["fn"].as_str().unwrap().to_string();
        *counts.entry(fn_name.clone()).or_default() += 1;
        match run(row, &progs) {
            Some(got) => assert_eq!(
                strip_nulls(&got),
                strip_nulls(&row["result"]),
                "{fn_name}: {}",
                row["args"]
            ),
            None => {
                // JS answered, so the skip cannot hide a row where JS had nothing to say.
                assert!(
                    !row["result"].is_null(),
                    "{fn_name}: blocked row with a null JS result: {}",
                    row["args"]
                );
                *blocked.entry(fn_name).or_default() += 1;
            }
        }
    }
    let got: Vec<(&str, usize)> = counts.iter().map(|(n, c)| (n.as_str(), *c)).collect();
    assert_eq!(got, EXPECTED);
    let got: Vec<(&str, usize)> = blocked.iter().map(|(n, c)| (n.as_str(), *c)).collect();
    assert_eq!(got, BLOCKED);
}

/// JS `restIsInert` treats the found call itself as inert wherever it stands, including as a
/// `for` init or update statement; any other statement there is not a pure expression.
#[test]
fn rest_is_inert_for_init_and_update() {
    let progs = programs();
    let p = &progs[0];
    let callee = &p.functions[0];
    let ctx = make_ctx(
        p,
        &json!({
            "inlining": [], "unrolling": false, "callerBound": [], "zpNames": [],
            "currentFn": null, "consumed": [], "retired": []
        }),
    );
    let stmt = |init: Value, update: Value| -> Stmt {
        parse(&json!({"kind": "for", "init": init, "test": null, "update": update, "body": []}))
    };
    let call_stmt = |name: &str| json!({"kind": "call", "name": name, "args": []});
    let found_in_init = stmt(call_stmt("f"), Value::Null);
    let Stmt::For(f) = &found_in_init else {
        unreachable!()
    };
    let Some(Stmt::Call(found)) = f.init.as_option().map(|s| &**s) else {
        unreachable!()
    };
    assert!(rest_is_inert(
        &found_in_init,
        found,
        callee,
        &ctx,
        &p.functions
    ));

    let found_in_update = stmt(Value::Null, call_stmt("f"));
    let Stmt::For(f) = &found_in_update else {
        unreachable!()
    };
    let Some(Stmt::Call(found)) = f.update.as_option().map(|s| &**s) else {
        unreachable!()
    };
    assert!(rest_is_inert(
        &found_in_update,
        found,
        callee,
        &ctx,
        &p.functions
    ));

    // Another call statement as the init is not the found call.
    let other = stmt(call_stmt("g"), Value::Null);
    assert!(!rest_is_inert(&other, found, callee, &ctx, &p.functions));
}
