//! Replays `fixtures/startup.json` (made by `gen/startup.mjs` in Node).

use mos::asm::assemble::Directive;
use mos::startup::commodore::{
    borrow_zero_page, epilogue, prologue, return_zero_page, uses_decimal_sensitive_math,
    zero_page_save_data,
};
use mos::startup::multiply::{
    MULTIPLY_LABEL, MULTIPLY_ZP_BYTES, MultiplyCells, multiply_cells, multiply_routine,
};
use mos::startup::nes::nes_reset_init;
use serde_json::Value;

fn dirs(v: &Value) -> Vec<Directive> {
    serde_json::from_value(v.clone()).expect("directives")
}

fn n(v: &Value) -> i64 {
    v.as_i64().unwrap()
}

#[test]
fn startup_generators_match_js() {
    let rows: Vec<Value> = serde_json::from_str(include_str!("fixtures/startup.json")).unwrap();
    let mut count = 0;
    for row in &rows {
        let a = &row["args"];
        let want = &row["result"];
        match row["fn"].as_str().unwrap() {
            "usesDecimalSensitiveMath" => {
                assert_eq!(
                    uses_decimal_sensitive_math(&dirs(&a[0])),
                    want.as_bool().unwrap()
                );
            }
            "prologue" => assert_eq!(prologue(a[0].as_bool().unwrap()), dirs(want)),
            "epilogue" => assert_eq!(epilogue(), dirs(want)),
            "borrowZeroPage" => assert_eq!(borrow_zero_page(n(&a[0]), n(&a[1])), dirs(want), "{a}"),
            "returnZeroPage" => assert_eq!(return_zero_page(n(&a[0]), n(&a[1])), dirs(want), "{a}"),
            "zeroPageSaveData" => assert_eq!(zero_page_save_data(n(&a[0])), dirs(want), "{a}"),
            "MULTIPLY_LABEL" => assert_eq!(MULTIPLY_LABEL, want.as_str().unwrap()),
            "MULTIPLY_ZP_BYTES" => assert_eq!(MULTIPLY_ZP_BYTES, n(want)),
            "multiplyCells" => {
                let c = multiply_cells(n(&a[0]));
                assert_eq!(
                    (c.a, c.b, c.result),
                    (n(&want["a"]), n(&want["b"]), n(&want["result"]))
                );
            }
            "multiplyRoutine" => {
                let c = MultiplyCells {
                    a: n(&a[0]["a"]),
                    b: n(&a[0]["b"]),
                    result: n(&a[0]["result"]),
                };
                assert_eq!(multiply_routine(&c), dirs(want));
            }
            "nesResetInit" => assert_eq!(nes_reset_init(), dirs(want)),
            f => panic!("{f}"),
        }
        count += 1;
    }
    assert_eq!(count, rows.len());
    assert!(count > 60);
}
