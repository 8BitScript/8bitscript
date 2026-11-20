//! One test per diagnostic the parser gives, plus the lowering, span and id
//! rules. The parser never repeats what the lexer already reports.

mod common;

use common::{messages, nodes, parse_text};
use serde_json::Value;

fn one(text: &str) -> String {
    let m = messages(text);
    assert_eq!(m.len(), 1, "{text:?} gave {m:?}");
    m.into_iter().next().unwrap_or_default()
}

fn clean(text: &str) {
    assert_eq!(messages(text), Vec::<String>::new(), "{text:?}");
}

fn tree(text: &str) -> Value {
    serde_json::to_value(parse_text(text).ast).expect("serialize")
}

#[test]
fn clean_programs_have_no_diagnostics() {
    clean("");
    clean("let x = 1;");
    clean("fn main() {}");
    clean("pub fn f(a: u8) -> u8 { return a; }");
    clean("fn f() -> u8 { return 1; }");
    clean("use self::a::{b};");
    clean("fn f(x: u8) { match x { 1 => g(), _ => h() } }");
}

fn exact(text: &str, expected: &[&str]) {
    assert_eq!(messages(text), expected, "{text:?}");
}

#[test]
fn e3_reserved_words() {
    let group = "'struct' is not part of 8BitScript; group consts in a 'mod'";
    exact("struct P;", &[group]);
    exact(
        "enum E {}",
        &["'enum' is not part of 8BitScript; group consts in a 'mod'"],
    );
    exact(
        "impl P {}",
        &["'impl' is not part of 8BitScript; methods are functions in a 'mod'"],
    );
    exact(
        "trait T;",
        &["'trait' is not part of 8BitScript; methods are functions in a 'mod'"],
    );
    exact(
        "static N: u8 = 1;",
        &["'static' is not part of 8BitScript; a global is 'let mut' at the top level"],
    );
    exact("type A = u8;", &["8BitScript has no type aliases"]);
    exact("let t = struct;", &[group]);
    exact("mod m { struct Q; }", &[group]);
}

#[test]
fn e4_crate_paths() {
    let text = "'crate::' paths are not supported; use 'self::' or 'super::'";
    exact("use crate::a::{b};", &[text]);
    assert_eq!(messages("let x = crate;")[0], text);
}

#[test]
fn e6_e7_e8_expression_sugar() {
    exact("let a = x as u8;", &["write 'u8(x)' to convert a value"]);
    let refs = "8BitScript has no references; use memory::read and memory::write";
    exact("let a = &x;", &[refs]);
    exact("let a = *p;", &[refs]);
    exact(
        "let a = [0; 4];",
        &["an array literal lists its elements: [a, b, c]"],
    );
}

#[test]
fn e9_e10_operator_precedence() {
    exact(
        "let a = x == y & z;",
        &["add parentheses: in 8BitScript '&' binds looser than '=='"],
    );
    exact(
        "let a = x | y < z;",
        &["add parentheses: in 8BitScript '|' binds looser than '<'"],
    );
    exact(
        "let a = x ^ y < z;",
        &["add parentheses: in 8BitScript '^' binds looser than '<'"],
    );
    let chain = "add parentheses: comparisons do not chain";
    exact("let a = x < y < z;", &[chain]);
    exact("let a = x == y == z;", &[chain]);
    exact("let a = x == y < z;", &[chain]);
    exact("let a = x < y == z;", &[chain]);
    clean("let a = (x == y) & z;");
    clean("let a = (x == y) | (y < z);");
    clean("let a = x == (y < z);");
}

#[test]
fn e11_match_in_expression() {
    exact(
        "let a = match x { 1 => 2 };",
        &["'match' is a statement; assign inside each arm"],
    );
}

#[test]
fn e12_macros_and_tests() {
    let text = "tests come with '8bs test'";
    exact("assert!(a);", &[text]);
    exact("#[test]\nfn t() {}", &[text]);
    exact("#[cfg(test)]\nfn t() {}", &[text]);
}

#[test]
fn e13_to_e15_match_shape() {
    let subject = "match compares a name or path; bind the value first: let v = …;";
    exact("match f(x) { 1 => a() }", &[subject]);
    exact("match 5 { 1 => a() }", &[subject]);
    exact(
        "match x { _ => a(), 1 => b() }",
        &["'_' must be the last arm"],
    );
    exact(
        "match x { _ | 2 => a(), 1 => b() }",
        &["'_' must be the last arm"],
    );
    exact("match x { }", &["a match needs at least one arm"]);
    exact(
        "match x { 1.5 => a() }",
        &["expected a pattern, found '1.5'"],
    );
}

#[test]
fn e16_e17_semicolons_and_tail() {
    exact(
        "fn f() -> u8 { 1 }",
        &["write 'return …;' to return a value"],
    );
    exact("fn g() { 1 }", &["expected ';', found '}'"]);
    exact("let x = 1", &["expected ';', found end of file"]);
    clean("fn f() -> u8 { return 1; }");
}

#[test]
fn e18_inner_attributes() {
    exact("#![no_std]", &["inner attributes are not supported"]);
}

#[test]
fn e19_pub_only_before_declarations() {
    exact("pub 5;", &["expected a declaration after 'pub', found '5'"]);
    exact(
        "pub use a::{b};",
        &["expected a declaration after 'pub', found 'use'"],
    );
}

#[test]
fn e21_old_syntax() {
    let text = parser::old_syntax_message();
    for source in [
        "function f() {}",
        "import { a } from \"./a.8bs\";",
        "export const X = 1;",
        "namespace N {}",
    ] {
        exact(source, &[text.as_str()]);
    }
    // inside a mod it is one error per old item, not one per token
    exact("mod M { function f() {} }", &[text.as_str()]);
    exact(
        "mod M { function f() {} export function g() {} }",
        &[text.as_str(), text.as_str()],
    );
}

#[test]
fn an_attribute_name_must_be_an_identifier() {
    exact(
        "#[5]\nfn f() {}",
        &["expected an attribute name, found '5'"],
    );
    clean("#[inline]\nfn f() {}");
    // no empty decorator list is left on the declaration
    assert!(!tree("#[5]\nfn f() {}").to_string().contains("decorators"));
}

#[test]
fn a_trailing_attribute_is_an_error() {
    exact(
        "#[unroll]",
        &["expected a declaration after the attribute, found end of file"],
    );
    exact(
        "fn f() { #[unroll] }",
        &["expected a declaration after the attribute, found '}'"],
    );
}

#[test]
fn a_mod_member_error_is_reported_once() {
    exact(
        "mod M { a b c d; fn f() {} }",
        &["expected a function or const inside a mod, found 'a'"],
    );
}

#[test]
fn super_and_self_only_start_a_path() {
    exact(
        "use foo::super::x;",
        &["'super' is only allowed at the start of a path"],
    );
    exact(
        "use foo::self::x;",
        &["'self' is only allowed at the start of a path"],
    );
    clean("use super::super::up::x;");
}

#[test]
fn a_wildcard_inside_an_arm_is_the_catch_all() {
    // `_ | 2` is the else, never a missing one
    let v = tree("fn f(x: u8) { match x { 1 => a(), _ | 2 => b() } }").to_string();
    assert_eq!(v.matches("IfStatement").count(), 1);
    assert!(v.contains("\"alternate\""));
    let v = tree("fn f(x: u8) { match x { 1 => a(), 2 | _ => b() } }").to_string();
    assert_eq!(v.matches("IfStatement").count(), 1);
    assert!(v.contains("\"alternate\""));
    // only a wildcard arm: its body alone
    let v = tree("fn f(x: u8) { match x { _ | 1 => a() } }").to_string();
    assert_eq!(v.matches("IfStatement").count(), 0);
    // a wildcard arm in the middle is E14 and nothing is lowered
    exact(
        "fn f(x: u8) { match x { 1 => a(), _ | 2 => b(), 3 => c() } }",
        &["'_' must be the last arm"],
    );
}

#[test]
fn lexer_diagnostics_are_not_repeated() {
    // E1, E2 and E5 come from the lexer; the parser stays silent about them.
    assert_eq!(messages("x++;\n--y;"), Vec::<String>::new());
    assert_eq!(messages("let a = c ? b : d;"), Vec::<String>::new());
    assert_eq!(messages("let s = 'A';"), Vec::<String>::new());
}

#[test]
fn template_fields_are_checked() {
    exact(
        "let a = `${x:y}`;",
        &["expected a field width after ':', found 'y'"],
    );
    exact(
        "let a = `${}`;",
        &["expected an expression, found end of file"],
    );
    clean("let a = `HP ${hp:3} ${a + 1}`;");
}

#[test]
fn deep_nesting_is_reported_once() {
    let text = format!("let a = {}1{};", "(".repeat(5000), ")".repeat(5000));
    let m = messages(&text);
    assert_eq!(
        m.iter().filter(|m| m.contains("nested too deeply")).count(),
        1
    );
}

#[test]
fn match_lowers_to_an_if_chain() {
    let v = tree("fn f(x: u8) { match x { 1 | 2 => a(), 3..=4 => b(), _ => c() } }");
    let text = v.to_string();
    assert!(text.contains("IfStatement"));
    assert!(text.contains("\"operator\":\"||\""));
    assert!(text.contains("\"operator\":\"&&\""));
    assert!(text.contains("\"operator\":\">=\""));
    assert!(!text.contains("MatchStatement"));
}

#[test]
fn spans_count_utf16_units() {
    let text = "// é😀\nlet x = 1;";
    let parsed = parse_text(text);
    let units = text.encode_utf16().count() as u32;
    assert_eq!((parsed.ast.start, parsed.ast.length), (0, units));
    let all = nodes(&parsed.ast);
    let decl = all
        .iter()
        .find(|n| n.type_name() == "VariableDeclaration")
        .expect("declaration");
    // "// é😀\n" is 7 UTF-16 units (the emoji is two).
    assert_eq!(decl.start, 7);
}

#[test]
fn children_stay_inside_their_parent() {
    let text = "fn f(a: u8) -> u8 { let b = a + 1; if b > 2 { return b; } return a * 2; }";
    let parsed = parse_text(text);
    assert!(parsed.diagnostics.is_empty());
    fn check(n: &syntax::Node) {
        for c in syntax::children(n) {
            assert!(c.start >= n.start && c.start + c.length <= n.start + n.length);
            check(c);
        }
    }
    check(&parsed.ast);
}

#[test]
fn ids_are_assigned_in_pre_order() {
    let parsed = parse_text("fn f() { let a = 1; let b = 2; }");
    let ids: Vec<u32> = nodes(&parsed.ast).iter().map(|n| n.id.0).collect();
    let expected: Vec<u32> = (0..ids.len() as u32).collect();
    assert_eq!(ids, expected);
}

#[test]
fn e21_full_text_comes_from_the_release_constant() {
    assert_eq!(parser::MIGRATE_RELEASE, "0.27.0");
    assert_eq!(
        one("function f() {}"),
        "this is the old 8BitScript syntax; run '8bs migrate' from 8BitScript 0.27.0 to convert it"
    );
    assert_eq!(one("function f() {}"), parser::old_syntax_message());
}

fn bx(text: &str) -> Vec<String> {
    common::messages_bx(text)
}

fn bx_tree(text: &str) -> Value {
    serde_json::to_value(common::parse_kind(text, syntax::SourceKind::Bx).ast).expect("serialize")
}

#[test]
fn components_and_state_parse_in_8bx() {
    assert_eq!(
        bx("pub component Menu(a: u8, b: u8 = 3,) { state s: u8 = 0; }"),
        Vec::<String>::new()
    );
    let v = bx_tree("pub component M(a: u8, b: u8 = 3) { state s: u8 = 0; }").to_string();
    assert!(v.contains("\"type\":\"ComponentDeclaration\""));
    assert!(v.contains("\"exported\":true"));
    assert!(v.contains("\"allowsChildren\":false"));
    assert!(v.contains("\"type\":\"StateDeclaration\""));
    assert!(v.contains("\"kind\":\"state\""));
    // a parameter with a default is optional, one without is not
    assert!(v.contains("\"optional\":true"));
    assert!(v.contains("\"optional\":false"));
    // a function parameter has no such field
    assert!(!tree("fn f(a: u8 = 1) {}").to_string().contains("optional"));
}

#[test]
fn component_diagnostics_have_exact_text() {
    // the cascade after a missing name is the JS parser's: each `expect`
    // reports what it found and the body reads on
    assert_eq!(
        bx("component 5() {}"),
        [
            "expected a component name, found '5'",
            "expected '(', found '5'",
            "expected '{', found '5'",
            "expected ';', found '{'",
            "expected '}', found end of file",
        ]
    );
    assert_eq!(bx("state mut x: u8 = 0;"), ["expected a name, found 'mut'"]);
    assert_eq!(bx("state ;"), ["expected a name, found ';'"]);
    assert_eq!(bx("component C(a: u8 {}"), ["expected ')', found '{'"]);
    assert_eq!(bx("component C(a) {}"), ["expected ':', found ')'"]);
    assert_eq!(
        bx("component C() let"),
        [
            "expected '{', found 'let'",
            "expected a variable name, found end of file",
            "expected '}', found end of file"
        ]
    );
    assert_eq!(
        bx("component"),
        [
            "expected a component name, found end of file",
            "expected '(', found end of file",
            "expected '{', found end of file",
            "expected '}', found end of file",
        ]
    );
}

#[test]
fn component_is_a_name_in_8bs() {
    // `component` and `state` are keywords of `.8bx` only
    exact(
        "pub component C() {}",
        &["expected a declaration after 'pub', found 'component'"],
    );
    clean("let component = 1; let state = 2;");
}

#[test]
fn a_component_token_in_an_8bs_parse_is_an_error() {
    let text = "component C() {}";
    let lexed = lexer::tokenize(
        text,
        "t",
        &lexer::Options {
            source_kind: Some(syntax::SourceKind::Bx),
        },
    );
    let parsed = parser::parse(&lexed.tokens, text, "t", &parser::Options::default());
    let m: Vec<String> = parsed.diagnostics.into_iter().map(|d| d.message).collect();
    assert_eq!(m[0], "'component' is only allowed in .8bx files");
}

fn allows_children(text: &str) -> Vec<bool> {
    let v = bx_tree(text);
    v["body"]
        .as_array()
        .expect("body")
        .iter()
        .filter(|n| n["type"] == "ComponentDeclaration")
        .map(|n| n["allowsChildren"].as_bool().expect("flag"))
        .collect()
}

#[test]
fn allows_children_needs_a_top_level_slot() {
    assert_eq!(allows_children("component F() { <slot /> }"), [true]);
    assert_eq!(allows_children("component F() { <A /> }"), [false]);
    assert_eq!(allows_children("component F() {}"), [false]);
    // only a direct child of the body counts, as in the JS parser
    assert_eq!(
        allows_children("component F() { if true { <slot /> } }"),
        [false]
    );
}
