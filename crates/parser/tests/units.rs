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
    clean("fn f() -> u8 { 1 }");
    clean("use self::a::{b};");
    clean("fn f(x: u8) { match x { 1 => g(), _ => h() } }");
}

#[test]
fn e3_reserved_words() {
    assert!(one("struct P;").contains("'struct' is not part of 8BitScript"));
    assert!(one("enum E {}").contains("'enum'"));
    assert!(one("let t = trait;").contains("'trait'"));
    assert!(one("type A = u8;").contains("no type aliases"));
}

#[test]
fn e4_crate_paths() {
    assert!(one("use crate::a::{b};").contains("'crate::' paths are not supported"));
    assert!(one("let x = crate;").contains("'crate::'"));
}

#[test]
fn e6_e7_e8_expression_sugar() {
    assert!(one("let a = x as u8;").contains("write 'u8(x)'"));
    assert!(one("let a = &x;").contains("no references"));
    assert!(one("let a = *p;").contains("memory::read"));
    assert!(one("let a = [0; 4];").contains("an array literal lists its elements"));
}

#[test]
fn e9_e10_operator_precedence() {
    assert!(one("let a = x == y & z;").contains("'&' binds looser than '=='"));
    assert!(one("let a = x | y < z;").contains("'|' binds looser than '<'"));
    assert!(one("let a = x < y < z;").contains("comparisons do not chain"));
    clean("let a = (x == y) & z;");
    clean("let a = (x == y) | (y < z);");
}

#[test]
fn e11_match_in_expression() {
    assert!(one("let a = match x { 1 => 2 };").contains("'match' is a statement"));
}

#[test]
fn e12_macros_and_tests() {
    assert!(one("assert!(a);").contains("tests come with '8bs test'"));
    assert!(one("#[test]\nfn t() {}").contains("tests come with '8bs test'"));
    assert!(one("#[cfg(test)]\nfn t() {}").contains("tests come with '8bs test'"));
}

#[test]
fn e13_to_e15_match_shape() {
    assert!(one("match f(x) { 1 => a() }").contains("match compares a name or path"));
    assert!(one("match 5 { 1 => a() }").contains("match compares a name or path"));
    assert!(one("match x { _ => a(), 1 => b() }").contains("'_' must be the last arm"));
    assert!(one("match x { }").contains("a match needs at least one arm"));
    assert!(one("match x { 1.5 => a() }").contains("expected a pattern"));
}

#[test]
fn e16_e17_semicolons_and_tail() {
    assert!(one("fn f() -> u8 { 1 }\nfn g() { 1 }").contains("write 'return …;'"));
    assert!(one("let x = 1").contains("expected ';'"));
    clean("fn f() -> u8 { 1 }");
}

#[test]
fn e18_inner_attributes() {
    assert!(one("#![no_std]").contains("inner attributes are not supported"));
}

#[test]
fn e19_pub_only_before_declarations() {
    assert!(one("pub 5;").contains("expected a declaration after 'pub'"));
    assert!(one("pub use a::{b};").contains("expected a declaration after 'pub'"));
}

#[test]
fn e21_old_syntax() {
    for text in [
        "function f() {}",
        "import { a } from \"./a.8bs\";",
        "export const X = 1;",
        "namespace N {}",
    ] {
        assert!(one(text).contains("this is the old 8BitScript syntax"), "{text}");
    }
}

#[test]
fn an_attribute_name_must_be_an_identifier() {
    assert!(!messages("#[5]\nfn f() {}").is_empty());
    clean("#[inline]\nfn f() {}");
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
    assert!(one("let a = `${x:y}`;").contains("expected a field width"));
    assert!(one("let a = `${}`;").contains("expected an expression"));
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
