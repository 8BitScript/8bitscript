//! Port of mos/startup/waitframe.ts

/// True if any function waits for a frame (`usesWaitFrame`, `waitframe.ts:76`).
#[must_use]
pub fn uses_wait_frame(functions: &[mos_ir::Function]) -> bool {
    use crate::walk::{Flow, Node, visit_body};
    functions.iter().any(|function| {
        visit_body(&function.body, &mut |node| {
            if matches!(node, Node::Stmt(mos_ir::Stmt::WaitFrame(_))) {
                Flow::Stop
            } else {
                Flow::Continue
            }
        }) == Flow::Stop
    })
}

#[cfg(test)]
mod uses_tests {
    use super::uses_wait_frame;
    use crate::walk::testkit::{call, function};
    use serde_json::json;

    #[test]
    fn finds_a_wait_frame_at_any_depth_and_only_that() {
        let wait = json!({"kind": "waitFrame", "start": 0, "length": 0});
        let nested = json!([{"kind": "while", "test": {"kind": "const", "value": 1},
            "body": [{"kind": "block", "body": [wait]}], "start": 0, "length": 0}]);
        assert!(uses_wait_frame(&[
            function("a", &json!([])),
            function("b", &nested)
        ]));
        assert!(!uses_wait_frame(&[function(
            "a",
            &json!([call("waitFrame", &[])])
        )]));
        assert!(!uses_wait_frame(&[]));
    }
}
