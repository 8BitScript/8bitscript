//! Port of (new) IR walk in F5 order
//!
//! The JS back end walks the IR as untyped objects in `Object.values` order
//! (`collectCallNames`, `collectStringIndexes`, `collectCalls`, `usesWaitFrame`,
//! `usesMultiply`). The measured child order per node kind (spec fact F5) is
//! what this module follows, whatever the struct field order is:
//!
//! | kind | children |
//! | --- | --- |
//! | assign | `value` |
//! | binop | `left`, `right` |
//! | block | `body` |
//! | call | `args` |
//! | for | `init`, `test`, `update`, `body` |
//! | if | `test`, `then`, `else` |
//! | index | `array`, `index` |
//! | local | `init` |
//! | memoryRead | `address` |
//! | memoryWrite | `address`, `value` |
//! | return | `value` |
//! | storeIndex | `array`, `index`, `value` |
//! | stringByte | `string`, `index` |
//! | stringLength | `string` |
//! | unop | `argument` |
//! | while | `test`, `body` |
//!
//! The kinds the corpus has not produced yet follow their TypeScript field
//! order: cond `test`, `consequent`, `alternate`; portRead `port`; portWrite
//! `port`, `value`; stringCopy `target`, `source`; namespaceCall `args`;
//! record each field's `value`.

use crate::{Call, Expr, Stmt};

/// One IR node: a statement or an expression.
#[derive(Clone, Copy, Debug)]
pub enum Node<'a> {
    Stmt(&'a Stmt),
    Expr(&'a Expr),
}

/// What a visitor asks the walk to do next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flow {
    /// Go on, into this node's children.
    Continue,
    /// Stop the whole walk (JS `some` returning true).
    Stop,
}

impl<'a> Node<'a> {
    /// The call this node is, as a statement or an expression (`kind === 'call'`).
    #[must_use]
    pub fn as_call(&self) -> Option<&'a Call> {
        match *self {
            Node::Stmt(Stmt::Call(c)) | Node::Expr(Expr::Call(c)) => Some(c),
            _ => None,
        }
    }
}

/// Visits every node under `body` in pre-order. Returns [`Flow::Stop`] when a
/// visitor stopped the walk.
pub fn visit_body<'a>(body: &'a [Stmt], f: &mut impl FnMut(Node<'a>) -> Flow) -> Flow {
    for stmt in body {
        if visit_stmt(stmt, f) == Flow::Stop {
            return Flow::Stop;
        }
    }
    Flow::Continue
}

/// Visits `stmt` and everything under it in pre-order.
pub fn visit_stmt<'a>(stmt: &'a Stmt, f: &mut impl FnMut(Node<'a>) -> Flow) -> Flow {
    if f(Node::Stmt(stmt)) == Flow::Stop {
        return Flow::Stop;
    }
    match stmt {
        Stmt::Asm(_) | Stmt::Break(_) | Stmt::Continue(_) | Stmt::WaitFrame(_) => Flow::Continue,
        Stmt::Assign(s) => visit_expr(&s.value, f),
        Stmt::Block(s) => visit_body(&s.body, f),
        Stmt::Call(s) => visit_exprs(&s.args, f),
        Stmt::For(s) => {
            let flow = s
                .init
                .as_option()
                .map_or(Flow::Continue, |i| visit_stmt(i, f));
            let flow = then(flow, || {
                s.test
                    .as_option()
                    .map_or(Flow::Continue, |t| visit_expr(t, f))
            });
            let flow = then(flow, || {
                s.update
                    .as_option()
                    .map_or(Flow::Continue, |u| visit_stmt(u, f))
            });
            then(flow, || visit_body(&s.body, f))
        }
        Stmt::If(s) => {
            let flow = visit_expr(&s.test, f);
            let flow = then(flow, || visit_body(&s.then, f));
            then(flow, || {
                s.r#else
                    .as_ref()
                    .map_or(Flow::Continue, |arm| visit_body(arm, f))
            })
        }
        Stmt::Local(s) => visit_expr(&s.init, f),
        Stmt::MemoryRead(s) => visit_expr(&s.address, f),
        Stmt::MemoryWrite(s) => both(&s.address, &s.value, f),
        Stmt::Return(s) => s
            .value
            .as_ref()
            .map_or(Flow::Continue, |v| visit_expr(v, f)),
        Stmt::StoreIndex(s) => {
            let flow = both(&s.array, &s.index, f);
            then(flow, || visit_expr(&s.value, f))
        }
        Stmt::While(s) => {
            let flow = visit_expr(&s.test, f);
            then(flow, || visit_body(&s.body, f))
        }
        Stmt::PortWrite(s) => both(&s.port, &s.value, f),
        Stmt::StringCopy(s) => both(&s.target, &s.source, f),
        Stmt::NamespaceCall(s) => visit_exprs(&s.args, f),
        Stmt::PortRead(s) => visit_expr(&s.port, f),
    }
}

/// Runs `next` only while the walk goes on.
fn then(flow: Flow, next: impl FnOnce() -> Flow) -> Flow {
    if flow == Flow::Continue { next() } else { flow }
}

/// Visits `expr` and everything under it in pre-order.
pub fn visit_expr<'a>(expr: &'a Expr, f: &mut impl FnMut(Node<'a>) -> Flow) -> Flow {
    if f(Node::Expr(expr)) == Flow::Stop {
        return Flow::Stop;
    }
    match expr {
        Expr::Const(_) | Expr::Ref(_) | Expr::String(_) | Expr::NamespaceConst(_) => Flow::Continue,
        Expr::Binop(e) => both(&e.left, &e.right, f),
        Expr::Call(e) => visit_exprs(&e.args, f),
        Expr::Index(e) => both(&e.array, &e.index, f),
        Expr::MemoryRead(e) => visit_expr(&e.address, f),
        Expr::StringByte(e) => both(&e.string, &e.index, f),
        Expr::StringLength(e) => visit_expr(&e.string, f),
        Expr::Unop(e) => visit_expr(&e.argument, f),
        Expr::Cond(e) => {
            let flow = visit_expr(&e.test, f);
            let flow = then(flow, || visit_expr(&e.consequent, f));
            then(flow, || visit_expr(&e.alternate, f))
        }
        Expr::PortRead(e) => visit_expr(&e.port, f),
        Expr::PortWrite(e) => both(&e.port, &e.value, f),
        Expr::NamespaceCall(e) => visit_exprs(&e.args, f),
        Expr::Record(e) => {
            for field in &e.fields {
                if visit_expr(&field.value, f) == Flow::Stop {
                    return Flow::Stop;
                }
            }
            Flow::Continue
        }
    }
}

fn visit_exprs<'a>(exprs: &'a [Expr], f: &mut impl FnMut(Node<'a>) -> Flow) -> Flow {
    for expr in exprs {
        if visit_expr(expr, f) == Flow::Stop {
            return Flow::Stop;
        }
    }
    Flow::Continue
}

fn both<'a>(a: &'a Expr, b: &'a Expr, f: &mut impl FnMut(Node<'a>) -> Flow) -> Flow {
    let flow = visit_expr(a, f);
    then(flow, || visit_expr(b, f))
}

/// IR builders for the tests of every module that walks the IR (the `mos` and `optimize` tests use them).
#[doc(hidden)]
pub mod testkit {
    use crate::{Function, Stmt};
    use serde_json::{Value, json};

    pub fn stmts(value: &Value) -> Vec<Stmt> {
        serde_json::from_value(value.clone()).expect("statements parse")
    }

    pub fn function(name: &str, body: &Value) -> Function {
        serde_json::from_value(json!({
            "name": name, "exported": false, "params": [], "returnType": "void",
            "body": body, "start": 0, "length": 0, "file": "t.8bs",
        }))
        .expect("function parses")
    }

    pub fn call(name: &str, args: &[Value]) -> Value {
        json!({"kind": "call", "name": name, "args": args})
    }

    pub fn konst(value: i64) -> Value {
        json!({"kind": "const", "value": value})
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use serde_json::json;

    fn kinds(body: &serde_json::Value) -> Vec<String> {
        let mut out = Vec::new();
        let body = stmts(body);
        visit_body(&body, &mut |n| {
            out.push(match n {
                Node::Stmt(Stmt::Call(c)) => format!("S:call:{}", c.name),
                Node::Stmt(Stmt::Local(l)) => format!("S:local:{}", l.name),
                Node::Stmt(Stmt::Assign(a)) => format!("S:assign:{}", a.target),
                Node::Stmt(s) => format!(
                    "S:{}",
                    serde_json::to_value(s).unwrap()["kind"].as_str().unwrap()
                ),
                Node::Expr(Expr::Const(c)) => format!("E:const:{}", c.value),
                Node::Expr(Expr::Ref(r)) => format!("E:ref:{}", r.name),
                Node::Expr(Expr::Call(c)) => format!("E:call:{}", c.name),
                Node::Expr(e) => format!(
                    "E:{}",
                    serde_json::to_value(e).unwrap()["kind"].as_str().unwrap()
                ),
            });
            Flow::Continue
        });
        out
    }

    fn r(name: &str) -> serde_json::Value {
        json!({"kind": "ref", "name": name})
    }

    #[test]
    fn for_visits_init_test_update_then_body() {
        let body = json!([{
            "kind": "for",
            "init": {"kind": "local", "name": "i", "type": "u8", "init": konst(0)},
            "test": {"kind": "binop", "operator": "<", "left": r("i"), "right": konst(3), "type": "bool"},
            "update": {"kind": "assign", "target": "i", "value": konst(1)},
            "body": [call("f", &[])],
        }]);
        assert_eq!(
            kinds(&body),
            [
                "S:for",
                "S:local:i",
                "E:const:0",
                "E:binop",
                "E:ref:i",
                "E:const:3",
                "S:assign:i",
                "E:const:1",
                "S:call:f"
            ]
        );
    }

    #[test]
    fn if_visits_test_then_else_and_while_test_then_body() {
        let body = json!([
            {"kind": "if", "test": r("a"), "then": [call("t", &[])], "else": [call("e", &[])], "start": 0, "length": 0},
            {"kind": "if", "test": r("b"), "then": [], "else": null, "start": 0, "length": 0},
            {"kind": "while", "test": r("c"), "body": [call("w", &[])], "start": 0, "length": 0},
        ]);
        assert_eq!(
            kinds(&body),
            [
                "S:if", "E:ref:a", "S:call:t", "S:call:e", "S:if", "E:ref:b", "S:while", "E:ref:c",
                "S:call:w"
            ]
        );
    }

    #[test]
    fn expression_children_follow_the_measured_order() {
        let body = json!([
            {"kind": "memoryWrite", "address": r("a"), "value": r("v"), "start": 0, "length": 0},
            {"kind": "storeIndex", "array": r("arr"), "index": r("i"), "value": r("v"), "elementType": "u8", "start": 0, "length": 0},
            {"kind": "return", "value": {"kind": "unop", "operator": "-", "argument": r("u"), "type": "i8"}, "start": 0, "length": 0},
            {"kind": "return", "value": null, "start": 0, "length": 0},
            {"kind": "assign", "target": "x", "value": {
                "kind": "stringByte", "string": r("s"),
                "index": {"kind": "index", "array": r("p"), "index": r("q"), "elementType": "u8", "type": "u8"},
                "type": "u8"}},
            {"kind": "memoryRead", "address": {"kind": "stringLength", "string": r("t"), "type": "u8"}, "type": "u8", "start": 0, "length": 0},
        ]);
        assert_eq!(
            kinds(&body),
            [
                "S:memoryWrite",
                "E:ref:a",
                "E:ref:v",
                "S:storeIndex",
                "E:ref:arr",
                "E:ref:i",
                "E:ref:v",
                "S:return",
                "E:unop",
                "E:ref:u",
                "S:return",
                "S:assign:x",
                "E:stringByte",
                "E:ref:s",
                "E:index",
                "E:ref:p",
                "E:ref:q",
                "S:memoryRead",
                "E:stringLength",
                "E:ref:t"
            ]
        );
    }

    #[test]
    fn leaf_statements_and_blocks() {
        let body = json!([
            {"kind": "asm", "text": "nop", "start": 0, "length": 0},
            {"kind": "break", "start": 0, "length": 0},
            {"kind": "continue", "start": 0, "length": 0},
            {"kind": "waitFrame", "start": 0, "length": 0},
            {"kind": "block", "origin": "f", "body": [call("g", &[konst(1)])]},
        ]);
        assert_eq!(
            kinds(&body),
            [
                "S:asm",
                "S:break",
                "S:continue",
                "S:waitFrame",
                "S:block",
                "S:call:g",
                "E:const:1"
            ]
        );
    }

    #[test]
    fn rarely_produced_kinds_follow_their_declared_order() {
        let body = json!([
            {"kind": "portWrite", "port": r("p"), "value": r("v"), "start": 0, "length": 0},
            {"kind": "stringCopy", "target": r("t"), "source": r("s"), "capacity": 4, "start": 0, "length": 0},
            {"kind": "namespaceCall", "namespace": "n", "member": "m", "args": [r("a1"), r("a2")], "start": 0, "length": 0},
            {"kind": "assign", "target": "x", "value": {
                "kind": "cond", "test": r("c"), "consequent": r("y"), "alternate": r("z")}},
            {"kind": "assign", "target": "x", "value": {
                "kind": "portRead", "port": r("pr"), "type": "u8", "start": 0, "length": 0}},
            {"kind": "assign", "target": "x", "value": {
                "kind": "namespaceCall", "namespace": "n", "member": "m", "args": [r("b")], "start": 0, "length": 0}},
            {"kind": "assign", "target": "x", "value": {
                "kind": "namespaceConst", "namespace": "n", "member": "m", "start": 0, "length": 0}},
            {"kind": "assign", "target": "x", "value": {
                "kind": "record", "start": 0, "length": 0, "fields": [
                    {"name": "a", "value": r("f1"), "start": 0, "length": 0},
                    {"name": "b", "value": r("f2"), "start": 0, "length": 0}]}},
        ]);
        let got = kinds(&body);
        let refs: Vec<&str> = got
            .iter()
            .filter_map(|k| k.strip_prefix("E:ref:"))
            .collect();
        assert_eq!(
            refs,
            [
                "p", "v", "t", "s", "a1", "a2", "c", "y", "z", "pr", "b", "f1", "f2"
            ]
        );
        assert!(got.contains(&"E:namespaceConst".to_string()));
    }

    #[test]
    fn stop_ends_the_walk_at_every_level() {
        let body = stmts(&json!([
            {"kind": "if", "test": r("a"), "then": [call("x", &[])], "else": null, "start": 0, "length": 0},
            call("never", &[]),
        ]));
        let mut seen = Vec::new();
        let flow = visit_body(&body, &mut |n| {
            if let Some(c) = n.as_call() {
                seen.push(c.name.clone());
                return Flow::Stop;
            }
            Flow::Continue
        });
        assert_eq!(flow, Flow::Stop);
        assert_eq!(seen, ["x"]);
    }

    #[test]
    fn as_call_matches_statement_and_expression_calls_only() {
        let body = stmts(
            &json!([call("s", &[call("e", &[])]), {"kind": "break", "start": 0, "length": 0}]),
        );
        let mut names = Vec::new();
        visit_body(&body, &mut |n| {
            names.push(n.as_call().map(|c| c.name.clone()));
            Flow::Continue
        });
        assert_eq!(names, [Some("s".to_string()), Some("e".to_string()), None]);
    }

    #[test]
    fn stop_inside_each_container_propagates() {
        // A stop deep in a for, a store, a cond and a record still stops the walk.
        for body in [
            json!([{"kind": "for", "init": null, "test": null, "update": null, "body": [call("hit", &[])]}]),
            json!([{"kind": "for", "init": call("hit", &[]), "test": call("no", &[]), "update": null, "body": []}]),
            json!([{"kind": "for", "init": null, "test": call("hit", &[]), "update": call("no", &[]), "body": []}]),
            json!([{"kind": "for", "init": null, "test": null, "update": call("hit", &[]), "body": [call("no", &[])]}]),
            json!([{"kind": "storeIndex", "array": call("hit", &[]), "index": call("no", &[]), "value": konst(0), "elementType": "u8", "start": 0, "length": 0}]),
            json!([{"kind": "storeIndex", "array": konst(0), "index": call("hit", &[]), "value": call("no", &[]), "elementType": "u8", "start": 0, "length": 0}]),
            json!([{"kind": "assign", "target": "x", "value": {"kind": "cond", "test": call("hit", &[]), "consequent": call("no", &[]), "alternate": konst(0)}}]),
            json!([{"kind": "assign", "target": "x", "value": {"kind": "cond", "test": konst(0), "consequent": call("hit", &[]), "alternate": call("no", &[])}}]),
            json!([{"kind": "assign", "target": "x", "value": {"kind": "record", "start": 0, "length": 0, "fields": [
                {"name": "a", "value": call("hit", &[]), "start": 0, "length": 0},
                {"name": "b", "value": call("no", &[]), "start": 0, "length": 0}]}}]),
            json!([{"kind": "if", "test": call("hit", &[]), "then": [call("no", &[])], "else": null, "start": 0, "length": 0}]),
            json!([{"kind": "while", "test": call("hit", &[]), "body": [call("no", &[])], "start": 0, "length": 0}]),
            json!([{"kind": "memoryWrite", "address": call("hit", &[]), "value": call("no", &[]), "start": 0, "length": 0}]),
        ] {
            let body = stmts(&body);
            let mut seen = Vec::new();
            let flow = visit_body(&body, &mut |n| {
                if let Some(c) = n.as_call() {
                    seen.push(c.name.clone());
                    if c.name == "hit" {
                        return Flow::Stop;
                    }
                }
                Flow::Continue
            });
            assert_eq!(flow, Flow::Stop);
            assert_eq!(seen.last().map(String::as_str), Some("hit"));
            assert!(!seen.contains(&"no".to_string()), "{seen:?}");
        }
    }
}
