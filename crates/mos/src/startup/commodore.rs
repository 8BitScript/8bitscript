//! Port of mos/startup/commodore.ts

use crate::asm::assemble::{Directive, Operand};
use crate::asm::encode::AddressingMode;

const ZP_SAVE_LABEL: &str = "__8bs_zp_save";

fn instr(mnemonic: &str, mode: AddressingMode, operand: Option<Operand>) -> Directive {
    Directive::Instruction {
        mnemonic: mnemonic.to_string(),
        mode,
        operand,
        prov: None,
    }
}

fn value(value: i64) -> Option<Operand> {
    Some(Operand::Value { value })
}

fn label_operand(name: &str) -> Option<Operand> {
    Some(Operand::Label {
        name: name.to_string(),
        byte: None,
        offset: None,
    })
}

/// True if `program` contains any ADC or SBC.
#[must_use]
pub fn uses_decimal_sensitive_math(program: &[Directive]) -> bool {
    program.iter().any(|d| {
        matches!(d, Directive::Instruction { mnemonic, .. } if mnemonic == "ADC" || mnemonic == "SBC")
    })
}

/// The program's opening: clear decimal mode when it does D-flag-sensitive
/// arithmetic.
#[must_use]
pub fn prologue(needs_cld: bool) -> Vec<Directive> {
    if needs_cld {
        vec![instr("CLD", AddressingMode::Implied, None)]
    } else {
        Vec::new()
    }
}

/// The program's close: RTS to the BASIC SYS that called us.
#[must_use]
pub fn epilogue() -> Vec<Directive> {
    vec![instr("RTS", AddressingMode::Implied, None)]
}

fn copy_loop(tag: &str, from: Directive, to: Directive, bytes: i64) -> Vec<Directive> {
    vec![
        instr("LDX", AddressingMode::Immediate, value(0)),
        Directive::Label {
            name: tag.to_string(),
            prov: None,
        },
        from,
        to,
        instr("INX", AddressingMode::Implied, None),
        instr("CPX", AddressingMode::Immediate, value(bytes)),
        instr("BNE", AddressingMode::Relative, label_operand(tag)),
    ]
}

/// Interrupts off, then `bytes` of zero page from `origin` into the image's
/// own buffer.
#[must_use]
pub fn borrow_zero_page(origin: i64, bytes: i64) -> Vec<Directive> {
    if bytes <= 0 {
        return Vec::new();
    }
    let mut out = vec![instr("SEI", AddressingMode::Implied, None)];
    out.extend(copy_loop(
        "__8bs_zp_borrow",
        instr("LDA", AddressingMode::AbsoluteX, value(origin)),
        instr(
            "STA",
            AddressingMode::AbsoluteX,
            label_operand(ZP_SAVE_LABEL),
        ),
        bytes,
    ));
    out
}

/// The same bytes back where BASIC left them, and interrupts on again.
#[must_use]
pub fn return_zero_page(origin: i64, bytes: i64) -> Vec<Directive> {
    if bytes <= 0 {
        return Vec::new();
    }
    let mut out = copy_loop(
        "__8bs_zp_return",
        instr(
            "LDA",
            AddressingMode::AbsoluteX,
            label_operand(ZP_SAVE_LABEL),
        ),
        instr("STA", AddressingMode::AbsoluteX, value(origin)),
        bytes,
    );
    out.push(instr("CLI", AddressingMode::Implied, None));
    out
}

/// The buffer itself, appended to the image beside the other data.
#[must_use]
pub fn zero_page_save_data(bytes: i64) -> Vec<Directive> {
    if bytes <= 0 {
        return Vec::new();
    }
    vec![
        Directive::Label {
            name: ZP_SAVE_LABEL.to_string(),
            prov: None,
        },
        Directive::Byte {
            // `bytes` is a positive count of zero page bytes.
            values: vec![0; usize::try_from(bytes).unwrap_or(0)],
            prov: None,
        },
    ]
}
