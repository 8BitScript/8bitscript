//! The bridge's JSON replies (port spec 4.1): shapes, errors that never trap,
//! and the one-call tokens + AST.

use front_wasm::{MAX_DIFFERENCES, check_json, parse_json, tokenize_json};
use serde_json::{Value, json};

fn call(f: fn(&[u8]) -> Vec<u8>, request: &Value) -> Value {
    serde_json::from_slice(&f(&serde_json::to_vec(request).unwrap())).expect("reply is JSON")
}

#[test]
fn tokenize_returns_tokens_and_diagnostics() {
    let reply = call(
        tokenize_json,
        &json!({"file": "t.8bs", "text": "let x = 1;", "sourceKind": ".8bs"}),
    );
    assert_eq!(reply["tokens"][0]["text"], json!("let"));
    assert_eq!(reply["tokens"][0]["kind"], json!("keyword"));
    assert_eq!(reply["diagnostics"], json!([]));
}

#[test]
fn tokenize_reports_lexer_diagnostics() {
    let reply = call(
        tokenize_json,
        &json!({"file": "t.8bs", "text": "x++;", "sourceKind": ".8bs"}),
    );
    assert_eq!(reply["diagnostics"].as_array().unwrap().len(), 1);
}

#[test]
fn parse_returns_tokens_ast_and_both_diagnostic_lists() {
    let reply = call(
        parse_json,
        &json!({"file": "t.8bs", "text": "let x = ;", "sourceKind": ".8bs"}),
    );
    assert_eq!(reply["ast"]["type"], json!("Program"));
    assert!(!reply["tokens"].as_array().unwrap().is_empty());
    assert_eq!(reply["lexerDiagnostics"], json!([]));
    assert!(!reply["diagnostics"].as_array().unwrap().is_empty());
}

#[test]
fn source_kind_defaults_to_bs_and_bx_is_accepted() {
    let reply = call(parse_json, &json!({"text": "let x = 1;"}));
    assert_eq!(reply["diagnostics"], json!([]));
    let reply = call(
        tokenize_json,
        &json!({"file": "a.8bx", "text": "component A() { <Box />; }", "sourceKind": ".8bx"}),
    );
    assert!(reply.get("error").is_none(), "{reply}");
}

#[test]
fn malformed_requests_are_error_replies() {
    for bytes in [&b"not json"[..], b"[]", b"", b"{\"text\": 3}"] {
        let reply: Value = serde_json::from_slice(&parse_json(bytes)).expect("JSON");
        assert!(reply["error"].is_string(), "{reply}");
    }
    let reply = call(parse_json, &json!({"text": "", "sourceKind": ".8bg"}));
    assert_eq!(reply["error"], json!("unsupported sourceKind `.8bg`"));
    let reply = call(parse_json, &json!({"text": "", "file": 4}));
    assert!(reply["error"].is_string());
    let reply = call(parse_json, &json!({"text": "", "sourceKind": 4}));
    assert!(reply["error"].is_string());
}

#[test]
fn check_requires_an_old_ast_and_new_text() {
    let reply = call(check_json, &json!({"newText": "let x = 1;"}));
    assert!(reply["error"].as_str().unwrap().contains("oldAst"));
    let reply = call(check_json, &json!({"oldAst": {}}));
    assert!(reply["error"].as_str().unwrap().contains("newText"));
}

#[test]
fn check_fails_when_the_new_text_has_diagnostics() {
    let reply = call(
        check_json,
        &json!({"oldAst": {"type": "Program", "body": []}, "newText": "x++;"}),
    );
    assert_eq!(reply["equal"], json!(false));
    assert_eq!(reply["differences"][0]["path"], json!("diagnostics"));
}

#[test]
fn check_lists_at_most_twenty_differences() {
    let old_body: Vec<Value> = (0..30).map(|_| json!({"type": "BreakStatement"})).collect();
    let reply = call(
        check_json,
        &json!({
            "oldAst": {"type": "Program", "body": old_body},
            "newText": "continue;".repeat(30),
        }),
    );
    assert_eq!(reply["equal"], json!(false));
    assert_eq!(
        reply["differences"].as_array().unwrap().len(),
        MAX_DIFFERENCES
    );
}

#[test]
fn check_refuses_a_tree_too_deep_to_compare() {
    let mut text = String::new();
    for _ in 0..120 {
        text.push_str("if a { ");
    }
    for _ in 0..120 {
        text.push_str("} ");
    }
    // A debug build uses large parser frames; the wasm build is the 1 MB case.
    let reply = std::thread::Builder::new()
        .stack_size(256 * 1024 * 1024)
        .spawn(move || {
            call(
                check_json,
                &json!({"oldAst": {"type": "Program", "body": []}, "newText": text}),
            )
        })
        .unwrap()
        .join()
        .unwrap();
    assert!(
        reply["error"].as_str().unwrap().contains("too deep"),
        "{reply}"
    );
}
