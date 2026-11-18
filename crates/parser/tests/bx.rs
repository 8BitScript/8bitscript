//! The `.8bx` tag grammar (P3-06): one exact-text test per diagnostic the
//! range gives, plus node shapes, spans and the text rule.

mod common;

use common::{nodes, parse_bx_text};
use parser::normalize_bx_text;
use serde_json::Value;

fn messages(text: &str) -> Vec<String> {
    parse_bx_text(text)
        .diagnostics
        .into_iter()
        .map(|d| d.message)
        .collect()
}

fn exact(text: &str, expected: &[&str]) {
    assert_eq!(messages(text), expected, "{text:?}");
}

fn types(text: &str) -> Vec<&'static str> {
    // Node type names in pre-order, from the serialized tree.
    let value = serde_json::to_value(parse_bx_text(text).ast).expect("serialize");
    let mut out = Vec::new();
    collect(&value, &mut out);
    out
}

fn collect(value: &Value, out: &mut Vec<&'static str>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(t)) = map.get("type") {
                out.push(match t.as_str() {
                    "BxElement" => "BxElement",
                    "BxFragment" => "BxFragment",
                    "BxAttribute" => "BxAttribute",
                    "BxSpreadAttribute" => "BxSpreadAttribute",
                    "BxText" => "BxText",
                    "BxExpressionChild" => "BxExpressionChild",
                    _ => "other",
                });
            }
            for v in map.values() {
                collect(v, out);
            }
        }
        Value::Array(items) => items.iter().for_each(|v| collect(v, out)),
        _ => {}
    }
}

#[test]
fn clean_elements_have_no_diagnostics() {
    exact("<A />;", &[]);
    exact("<A />", &[]);
    exact("<A b={1} c=\"x\" d />;", &[]);
    exact("<A>text {x} <B /></A>;", &[]);
    exact("<>x</>;", &[]);
    exact("<Ui.Panel></Ui.Panel>;", &[]);
    exact("let y = c ? <A /> : <B />;", &[]);
}

#[test]
fn node_shapes() {
    assert_eq!(
        types("<A b={1} {c}>t{d}{}<>x</></A>;"),
        [
            "other",
            "BxElement",
            "BxAttribute",
            "other",
            "BxSpreadAttribute",
            "other",
            "BxText",
            "BxExpressionChild",
            "other",
            "BxExpressionChild",
            "BxFragment",
            "BxText",
        ]
    );
}

#[test]
fn spans_are_tokens() {
    let parsed = parse_bx_text("<A b=\"x\">hi</A>");
    let all = nodes(&parsed.ast);
    let element = all.iter().find(|n| n.kind.type_name() == "BxElement");
    let element = element.expect("element");
    assert_eq!((element.start, element.length), (0, 15));
    let attr = all.iter().find(|n| n.kind.type_name() == "BxAttribute");
    let attr = attr.expect("attribute");
    assert_eq!((attr.start, attr.length), (3, 5));
    let text = all.iter().find(|n| n.kind.type_name() == "BxText");
    let text = text.expect("text");
    assert_eq!((text.start, text.length), (9, 2));
}

#[test]
fn bx_text_is_normalized() {
    assert_eq!(normalize_bx_text("  a  \n\n  b c \n"), "a b c");
    assert_eq!(normalize_bx_text("\n   \n"), "");
    assert_eq!(normalize_bx_text(""), "");
    assert_eq!(normalize_bx_text("\u{feff} x \u{a0}"), "x");
}

#[test]
fn whitespace_only_text_is_no_child() {
    assert!(!types("<A>\n   \n</A>;").contains(&"BxText"));
}

#[test]
fn string_attribute_values() {
    let value = serde_json::to_value(parse_bx_text("<A b=\"x\" c='y' />").ast).expect("serialize");
    let text = value.to_string();
    assert!(text.contains("\"value\":\"x\""), "{text}");
    assert!(text.contains("\"value\":\"y\""), "{text}");
}

#[test]
fn e_name_after_open() {
    // `<` before a number is a comparison to the lexer, so no tag opens.
    exact("<1 />;", &["expected an expression, found '<'"]);
}

#[test]
fn e_attribute_value() {
    exact(
        "<A b=3 />;",
        &["expected a string or {expression} after b=, found '/>'"],
    );
}

#[test]
fn e_unclosed_expression() {
    let m = messages("<A b={1 />;");
    assert_eq!(
        m,
        [
            "expected an expression, found '>'",
            "expected '}' to close the expression, found '>'",
            "unexpected '>' in <A>",
            "unexpected ';' in <A>",
            "unterminated <A>: expected '>' or '/>'",
        ]
    );
}

#[test]
fn e_unterminated_tag() {
    exact("<A b", &["unterminated <A>: expected '>' or '/>'"]);
}

#[test]
fn e_unclosed_element_and_fragment() {
    exact("<A>x", &["unclosed element <A>: expected </A>"]);
    exact("<>x", &["unclosed fragment: expected </>"]);
}

#[test]
fn e_closing_tag() {
    exact("<A></B>;", &["expected </A>, found </B>"]);
    exact("<A></>;", &["expected </A>, found '>'"]);
    let m = messages("<></A>;");
    assert_eq!(
        m.first().map(String::as_str),
        Some("expected </> to close the fragment, found 'A'")
    );
    exact("<A></A", &["expected '>' after </A"]);
}

#[test]
fn deep_nesting_stops_with_one_diagnostic() {
    let text = format!("{}{}", "<A>".repeat(2000), "</A>".repeat(2000));
    let m = messages(&text);
    assert!(
        m.iter().any(|x| x == "this is nested too deeply to parse"),
        "{:?}",
        m.first()
    );
}
