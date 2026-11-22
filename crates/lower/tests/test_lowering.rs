//! Test lowering: the shapes an assert becomes, single evaluation of operands, the numbering
//! and the sidecar, and that a normal build carries none of it.

use lower::function::{Lowered, lower, lower_tests};
use lower::tests::TestLowering;
use mos_ir::Function;

fn parse(text: &str, file: &str) -> syntax::Node {
    let lexed = lexer::tokenize(text, file, &lexer::Options::default());
    let parsed = parser::parse(&lexed.tokens, text, file, &parser::Options::default());
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    parsed.ast
}

fn test_build(text: &str, first: TestLowering) -> Lowered {
    let ast = parse(text, "a.8bs");
    lower_tests(&ast, "a.8bs", Some(text), first)
}

fn function<'a>(lowered: &'a Lowered, name: &str) -> &'a Function {
    lowered
        .ir
        .functions
        .iter()
        .find(|f| f.name == name)
        .unwrap_or_else(|| panic!("no function {name}"))
}

fn dump(f: &Function) -> String {
    serde_json::to_string(&f.body).expect("serialize")
}

const SHAPES: &str = "fn bump() -> u8 { return 1; }
#[test]
fn shapes() {
    let x: u8 = 3;
    assert_eq!(x, 3);
    assert!(x < 9, \"small\");
    assert!(x != 0 && x != 1);
    panic!(\"never\");
}
";

#[test]
fn a_test_becomes_a_private_void_function() {
    let lowered = test_build(SHAPES, TestLowering::default());
    assert!(lowered.diagnostics.is_empty(), "{:?}", lowered.diagnostics);
    let f = function(&lowered, "__test_0");
    assert_eq!(f.return_type, "void");
    assert!(f.params.is_empty());
    assert!(!f.exported);
    assert_eq!(
        lowered
            .ir
            .functions
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>(),
        ["bump", "__test_0"]
    );
}

#[test]
fn a_comparison_assert_hoists_its_operands() {
    let lowered = test_build(SHAPES, TestLowering::default());
    let body = &function(&lowered, "__test_0").body;
    // let x; then `let __a0; let __b0; if (!(__a0 == __b0)) { fail8(0, __a0, __b0) }`.
    let text = dump(function(&lowered, "__test_0"));
    assert!(text.contains(r#""name":"__a0""#), "{text}");
    assert!(text.contains(r#""name":"__b0""#), "{text}");
    assert!(text.contains(r#""name":"__8bs_test_fail8""#), "{text}");
    assert!(text.contains(r#""name":"__a1""#), "{text}");
    // The other shape is the plain guard and the failure with no operands.
    assert!(text.contains(r#""name":"__8bs_test_fail0""#), "{text}");
    assert!(!text.contains("__a2"), "{text}");
    // 1 local + 2 hoisted + 1 guard, 2 hoisted + 1 guard, 1 guard, 1 failure.
    assert_eq!(body.len(), 1 + 3 + 3 + 1 + 1);
}

#[test]
fn operands_are_evaluated_once() {
    let text = "fn bump() -> u8 { return 1; }
#[test]
fn once() { assert_eq!(bump(), 2); }
";
    let lowered = test_build(text, TestLowering::default());
    assert!(lowered.diagnostics.is_empty(), "{:?}", lowered.diagnostics);
    let dumped = dump(function(&lowered, "__test_0"));
    assert_eq!(dumped.matches(r#""name":"bump""#).count(), 1, "{dumped}");
}

#[test]
fn width_follows_the_operand_type() {
    let text = "#[test]
fn widths() {
    let a: u16 = 1;
    let b: i32 = 2;
    let c: u8 = 3;
    assert_eq!(a, a);
    assert_eq!(b, b);
    assert_eq!(c, c);
}
";
    let lowered = test_build(text, TestLowering::default());
    assert!(lowered.diagnostics.is_empty(), "{:?}", lowered.diagnostics);
    let dumped = dump(function(&lowered, "__test_0"));
    for name in ["__8bs_test_fail16", "__8bs_test_fail32", "__8bs_test_fail8"] {
        assert!(dumped.contains(name), "{name} in {dumped}");
    }
    let sidecar = lowered.tests.as_ref().expect("sidecar");
    let widths: Vec<(u32, bool)> = sidecar
        .asserts
        .iter()
        .map(|a| (a.width, a.signed))
        .collect();
    assert_eq!(widths, [(16, false), (32, true), (8, false)]);
}

#[test]
fn the_sidecar_says_what_each_one_was() {
    let lowered = test_build(SHAPES, TestLowering::default());
    let sidecar = lowered.tests.as_ref().expect("sidecar");
    assert_eq!(sidecar.version, 1);
    assert_eq!(sidecar.tests.len(), 1);
    let t = &sidecar.tests[0];
    assert_eq!(
        (t.k, t.name.as_str(), t.file.as_str(), t.line),
        (0, "shapes", "a.8bs", 2)
    );
    let ids: Vec<u32> = sidecar.asserts.iter().map(|a| a.id).collect();
    assert_eq!(ids, [0, 1, 2, 3]);
    let texts: Vec<&str> = sidecar.asserts.iter().map(|a| a.text.as_str()).collect();
    assert_eq!(
        texts,
        ["x == 3", "x < 9", "x != 0 && x != 1", "panic!(\"never\");"]
    );
    assert_eq!(sidecar.asserts[1].message.as_deref(), Some("small"));
    assert_eq!(sidecar.asserts[3].message.as_deref(), Some("never"));
    let a = &sidecar.asserts[1];
    assert_eq!((a.line, a.column), (6, 5));
    // The plain shapes carry no operand type.
    assert_eq!(
        (sidecar.asserts[2].width, &sidecar.asserts[2].ty),
        (0, &None)
    );
    let json = serde_json::to_value(sidecar).expect("serialize");
    assert_eq!(json["asserts"][0]["type"], "utinyint");
}

#[test]
fn numbering_runs_on_from_earlier_modules() {
    let text =
        "#[test]\nfn one() { assert!(true); }\n#[test]\nfn two() { assert!(true); panic!(); }\n";
    let lowered = test_build(
        text,
        TestLowering {
            first_test: 3,
            first_assert: 10,
        },
    );
    let names: Vec<&str> = lowered
        .ir
        .functions
        .iter()
        .map(|f| f.name.as_str())
        .collect();
    assert_eq!(names, ["__test_3", "__test_4"]);
    let sidecar = lowered.tests.as_ref().expect("sidecar");
    assert_eq!(
        sidecar.tests.iter().map(|t| t.k).collect::<Vec<_>>(),
        [3, 4]
    );
    assert_eq!(
        sidecar.asserts.iter().map(|a| a.id).collect::<Vec<_>>(),
        [10, 11, 12]
    );
    // The id is the first argument of the failure call.
    assert!(dump(function(&lowered, "__test_4")).contains(r#""value":11"#));
}

#[test]
fn tests_in_a_cfg_test_mod_are_lowered() {
    let text = "#[cfg(test)]\nmod tests {\n    fn helper() -> u8 { return 1; }\n    #[test]\n    fn it() { assert!(true); }\n}\n";
    let lowered = test_build(text, TestLowering::default());
    assert!(lowered.diagnostics.is_empty(), "{:?}", lowered.diagnostics);
    let names: Vec<&str> = lowered
        .ir
        .functions
        .iter()
        .map(|f| f.name.as_str())
        .collect();
    assert_eq!(names, ["tests_helper", "__test_0"]);
}

#[test]
fn a_normal_build_has_no_test_code() {
    let text = "fn keep() {}\n#[test]\nfn gone() { assert!(true); }\n#[cfg(test)]\nmod tests { #[test] fn t() { panic!(); } }\n";
    let mut ast = parse(text, "a.8bs");
    parser::strip_tests(&mut ast);
    let lowered = lower(&ast, "a.8bs", Some(text));
    assert!(lowered.diagnostics.is_empty(), "{:?}", lowered.diagnostics);
    assert!(lowered.tests.is_none());
    let names: Vec<&str> = lowered
        .ir
        .functions
        .iter()
        .map(|f| f.name.as_str())
        .collect();
    assert_eq!(names, ["keep"]);
    assert!(lowered.ir.namespaces.is_empty());
}

#[test]
fn a_normal_lowering_refuses_a_macro_it_was_not_asked_for() {
    let text = "#[test]\nfn t() { assert!(true); }\n";
    let ast = parse(text, "a.8bs");
    let lowered = lower(&ast, "a.8bs", Some(text));
    assert!(!lowered.diagnostics.is_empty());
    assert!(lowered.ir.functions.is_empty());
}

#[test]
fn a_function_named_assert_is_an_ordinary_call() {
    let text = "fn assert(ok: bool) {}\nfn fail(message: string) {}\nfn f() { assert(true); }\n";
    let ast = parse(text, "a.8bs");
    let lowered = lower(&ast, "a.8bs", Some(text));
    assert!(lowered.diagnostics.is_empty(), "{:?}", lowered.diagnostics);
    let dumped = dump(function(&lowered, "f"));
    assert!(dumped.contains(r#""name":"assert""#), "{dumped}");
}
