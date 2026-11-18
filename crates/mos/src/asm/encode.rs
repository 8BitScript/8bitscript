//! Port of mos/asm/encode.ts (types and byte counts)

use serde::{Deserialize, Serialize};

/// Every addressing mode the stock 6502 has (`encode.ts:16-29`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AddressingMode {
    #[serde(rename = "implied")]
    Implied,
    #[serde(rename = "accumulator")]
    Accumulator,
    #[serde(rename = "immediate")]
    Immediate,
    #[serde(rename = "zeropage")]
    Zeropage,
    #[serde(rename = "zeropage,x")]
    ZeropageX,
    #[serde(rename = "zeropage,y")]
    ZeropageY,
    #[serde(rename = "absolute")]
    Absolute,
    #[serde(rename = "absolute,x")]
    AbsoluteX,
    #[serde(rename = "absolute,y")]
    AbsoluteY,
    #[serde(rename = "indirect")]
    Indirect,
    #[serde(rename = "(indirect,x)")]
    IndirectX,
    #[serde(rename = "(indirect),y")]
    IndirectY,
    #[serde(rename = "relative")]
    Relative,
}

impl AddressingMode {
    /// The JS spelling, equal to the serde name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Implied => "implied",
            Self::Accumulator => "accumulator",
            Self::Immediate => "immediate",
            Self::Zeropage => "zeropage",
            Self::ZeropageX => "zeropage,x",
            Self::ZeropageY => "zeropage,y",
            Self::Absolute => "absolute",
            Self::AbsoluteX => "absolute,x",
            Self::AbsoluteY => "absolute,y",
            Self::Indirect => "indirect",
            Self::IndirectX => "(indirect,x)",
            Self::IndirectY => "(indirect),y",
            Self::Relative => "relative",
        }
    }
}

/// How many operand bytes follow the opcode (`encode.ts:32`).
#[must_use]
pub fn operand_bytes(mode: AddressingMode) -> i64 {
    match mode {
        AddressingMode::Implied | AddressingMode::Accumulator => 0,
        AddressingMode::Absolute
        | AddressingMode::AbsoluteX
        | AddressingMode::AbsoluteY
        | AddressingMode::Indirect => 2,
        _ => 1,
    }
}

/// Total instruction length: the opcode plus its operand (`encode.ts:39`).
#[must_use]
pub fn instruction_bytes(mode: AddressingMode) -> i64 {
    1 + operand_bytes(mode)
}
