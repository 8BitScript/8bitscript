//! Port of mos/startup/multiply.ts

/// True if any function still multiplies at run time after the optimizer's
/// strength reduction (`usesMultiply`, `multiply.ts:57`).
#[must_use]
pub fn uses_multiply(functions: &[mos_ir::Function]) -> bool {
    use crate::walk::{Flow, Node, visit_body};
    functions.iter().any(|function| {
        visit_body(&function.body, &mut |node| {
            if matches!(node, Node::Expr(mos_ir::Expr::Binop(b)) if b.operator == "*") {
                Flow::Stop
            } else {
                Flow::Continue
            }
        }) == Flow::Stop
    })
}

#[cfg(test)]
mod uses_tests {
    use super::uses_multiply;
    use crate::walk::testkit::function;
    use serde_json::json;

    #[test]
    fn finds_a_star_binop_and_ignores_other_operators() {
        let r = |n: &str| json!({"kind": "ref", "name": n});
        let binop = |op: &str| json!({"kind": "binop", "operator": op, "left": r("a"), "right": r("b"), "type": "u8"});
        let body = |op: &str| {
            json!([{"kind": "if", "test": r("c"), "then": [
            {"kind": "assign", "target": "x", "value": binop(op)}], "else": null, "start": 0, "length": 0}])
        };
        assert!(uses_multiply(&[function("f", &body("*"))]));
        assert!(!uses_multiply(&[function("f", &body("+"))]));
        assert!(!uses_multiply(&[]));
    }
}
