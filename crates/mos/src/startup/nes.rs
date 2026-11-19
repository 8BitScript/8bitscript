//! Port of mos/startup/nes.ts

use crate::asm::assemble::{Directive, Operand};
use crate::asm::encode::AddressingMode;

const PPU_CTRL: i64 = 0x2000;
const PPU_MASK: i64 = 0x2001;
const PPU_STATUS: i64 = 0x2002;
/// Bit 7: DMC IRQ enable.
const APU_DMC_FREQ: i64 = 0x4010;
/// Bit 6: frame IRQ inhibit.
const APU_FRAME_COUNTER: i64 = 0x4017;

fn instr(mnemonic: &str, mode: AddressingMode, value: Option<i64>) -> Directive {
    Directive::Instruction {
        mnemonic: mnemonic.to_string(),
        mode,
        operand: value.map(|value| Operand::Value { value }),
        prov: None,
    }
}

/// `BIT PPUSTATUS` / `BPL`: blocks until the PPU reports a vertical blank.
fn wait_vertical_blank(tag: &str) -> Vec<Directive> {
    vec![
        Directive::Label {
            name: tag.to_string(),
            prov: None,
        },
        instr("BIT", AddressingMode::Absolute, Some(PPU_STATUS)),
        Directive::Instruction {
            mnemonic: "BPL".to_string(),
            mode: AddressingMode::Relative,
            operand: Some(Operand::Label {
                name: tag.to_string(),
                byte: None,
                offset: None,
            }),
            prov: None,
        },
    ]
}

/// The reset-handler preamble every NES build begins with.
#[must_use]
pub fn nes_reset_init() -> Vec<Directive> {
    use AddressingMode::{Absolute, Immediate, Implied};
    let mut out = vec![
        instr("SEI", Implied, None),
        instr("LDX", Immediate, Some(0x40)),
        instr("STX", Absolute, Some(APU_FRAME_COUNTER)),
        instr("LDX", Immediate, Some(0xff)),
        instr("TXS", Implied, None),
        instr("INX", Implied, None),
        instr("STX", Absolute, Some(PPU_CTRL)),
        instr("STX", Absolute, Some(PPU_MASK)),
        instr("STX", Absolute, Some(APU_DMC_FREQ)),
        instr("BIT", Absolute, Some(PPU_STATUS)),
    ];
    out.extend(wait_vertical_blank("__8bs_nes_warmup_1"));
    out.extend(wait_vertical_blank("__8bs_nes_warmup_2"));
    out
}
