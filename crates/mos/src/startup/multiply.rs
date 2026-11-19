//! Port of mos/startup/multiply.ts

use crate::asm::assemble::{Directive, Operand};
use crate::asm::encode::AddressingMode;

pub const MULTIPLY_LABEL: &str = "__8bs_mul16";

/// Zero page the routine owns: operand A, operand B and the result, 2 bytes each.
pub const MULTIPLY_ZP_BYTES: i64 = 6;

/// The three zero-page cell pairs, from the routine's placed base address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MultiplyCells {
    pub a: i64,
    pub b: i64,
    pub result: i64,
}

#[must_use]
pub fn multiply_cells(base: i64) -> MultiplyCells {
    MultiplyCells {
        a: base,
        b: base + 2,
        result: base + 4,
    }
}

fn instr(mnemonic: &str, mode: AddressingMode, value: Option<i64>) -> Directive {
    Directive::Instruction {
        mnemonic: mnemonic.to_string(),
        mode,
        operand: value.map(|value| Operand::Value { value }),
        prov: None,
    }
}

fn label(name: &str) -> Directive {
    Directive::Label {
        name: name.to_string(),
        prov: None,
    }
}

fn branch(mnemonic: &str, target: &str) -> Directive {
    Directive::Instruction {
        mnemonic: mnemonic.to_string(),
        mode: AddressingMode::Relative,
        operand: Some(Operand::Label {
            name: target.to_string(),
            byte: None,
            offset: None,
        }),
        prov: None,
    }
}

/// The subroutine itself: result = A * B (low 16 bits), destroying A and B.
#[must_use]
pub fn multiply_routine(cells: &MultiplyCells) -> Vec<Directive> {
    use AddressingMode::{Immediate, Implied, Zeropage};
    let lp = format!("{MULTIPLY_LABEL}_loop");
    let skip = format!("{MULTIPLY_LABEL}_skip");
    vec![
        label(MULTIPLY_LABEL),
        instr("LDA", Immediate, Some(0)),
        instr("STA", Zeropage, Some(cells.result)),
        instr("STA", Zeropage, Some(cells.result + 1)),
        instr("LDX", Immediate, Some(16)),
        label(&lp),
        instr("LSR", Zeropage, Some(cells.b + 1)),
        instr("ROR", Zeropage, Some(cells.b)),
        branch("BCC", &skip),
        instr("CLC", Implied, None),
        instr("LDA", Zeropage, Some(cells.result)),
        instr("ADC", Zeropage, Some(cells.a)),
        instr("STA", Zeropage, Some(cells.result)),
        instr("LDA", Zeropage, Some(cells.result + 1)),
        instr("ADC", Zeropage, Some(cells.a + 1)),
        instr("STA", Zeropage, Some(cells.result + 1)),
        label(&skip),
        instr("ASL", Zeropage, Some(cells.a)),
        instr("ROL", Zeropage, Some(cells.a + 1)),
        instr("DEX", Implied, None),
        branch("BNE", &lp),
        instr("RTS", Implied, None),
    ]
}

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
