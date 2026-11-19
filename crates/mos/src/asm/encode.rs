//! Port of mos/asm/encode.ts

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

/// mnemonic to the opcode byte of each addressing mode it supports, in the
/// literal order of `OPCODES` (`encode.ts:44-145`); the order is visible in `encode` errors.
pub static OPCODES: &[(&str, &[(AddressingMode, u8)])] = &[
    (
        "ADC",
        &[
            (AddressingMode::Immediate, 0x69),
            (AddressingMode::Zeropage, 0x65),
            (AddressingMode::ZeropageX, 0x75),
            (AddressingMode::Absolute, 0x6d),
            (AddressingMode::AbsoluteX, 0x7d),
            (AddressingMode::AbsoluteY, 0x79),
            (AddressingMode::IndirectX, 0x61),
            (AddressingMode::IndirectY, 0x71),
        ],
    ),
    (
        "AND",
        &[
            (AddressingMode::Immediate, 0x29),
            (AddressingMode::Zeropage, 0x25),
            (AddressingMode::ZeropageX, 0x35),
            (AddressingMode::Absolute, 0x2d),
            (AddressingMode::AbsoluteX, 0x3d),
            (AddressingMode::AbsoluteY, 0x39),
            (AddressingMode::IndirectX, 0x21),
            (AddressingMode::IndirectY, 0x31),
        ],
    ),
    (
        "ASL",
        &[
            (AddressingMode::Accumulator, 0x0a),
            (AddressingMode::Zeropage, 0x06),
            (AddressingMode::ZeropageX, 0x16),
            (AddressingMode::Absolute, 0x0e),
            (AddressingMode::AbsoluteX, 0x1e),
        ],
    ),
    ("BCC", &[(AddressingMode::Relative, 0x90)]),
    ("BCS", &[(AddressingMode::Relative, 0xb0)]),
    ("BEQ", &[(AddressingMode::Relative, 0xf0)]),
    (
        "BIT",
        &[
            (AddressingMode::Zeropage, 0x24),
            (AddressingMode::Absolute, 0x2c),
        ],
    ),
    ("BMI", &[(AddressingMode::Relative, 0x30)]),
    ("BNE", &[(AddressingMode::Relative, 0xd0)]),
    ("BPL", &[(AddressingMode::Relative, 0x10)]),
    ("BRK", &[(AddressingMode::Implied, 0x00)]),
    ("BVC", &[(AddressingMode::Relative, 0x50)]),
    ("BVS", &[(AddressingMode::Relative, 0x70)]),
    ("CLC", &[(AddressingMode::Implied, 0x18)]),
    ("CLD", &[(AddressingMode::Implied, 0xd8)]),
    ("CLI", &[(AddressingMode::Implied, 0x58)]),
    ("CLV", &[(AddressingMode::Implied, 0xb8)]),
    (
        "CMP",
        &[
            (AddressingMode::Immediate, 0xc9),
            (AddressingMode::Zeropage, 0xc5),
            (AddressingMode::ZeropageX, 0xd5),
            (AddressingMode::Absolute, 0xcd),
            (AddressingMode::AbsoluteX, 0xdd),
            (AddressingMode::AbsoluteY, 0xd9),
            (AddressingMode::IndirectX, 0xc1),
            (AddressingMode::IndirectY, 0xd1),
        ],
    ),
    (
        "CPX",
        &[
            (AddressingMode::Immediate, 0xe0),
            (AddressingMode::Zeropage, 0xe4),
            (AddressingMode::Absolute, 0xec),
        ],
    ),
    (
        "CPY",
        &[
            (AddressingMode::Immediate, 0xc0),
            (AddressingMode::Zeropage, 0xc4),
            (AddressingMode::Absolute, 0xcc),
        ],
    ),
    (
        "DEC",
        &[
            (AddressingMode::Zeropage, 0xc6),
            (AddressingMode::ZeropageX, 0xd6),
            (AddressingMode::Absolute, 0xce),
            (AddressingMode::AbsoluteX, 0xde),
        ],
    ),
    ("DEX", &[(AddressingMode::Implied, 0xca)]),
    ("DEY", &[(AddressingMode::Implied, 0x88)]),
    (
        "EOR",
        &[
            (AddressingMode::Immediate, 0x49),
            (AddressingMode::Zeropage, 0x45),
            (AddressingMode::ZeropageX, 0x55),
            (AddressingMode::Absolute, 0x4d),
            (AddressingMode::AbsoluteX, 0x5d),
            (AddressingMode::AbsoluteY, 0x59),
            (AddressingMode::IndirectX, 0x41),
            (AddressingMode::IndirectY, 0x51),
        ],
    ),
    (
        "INC",
        &[
            (AddressingMode::Zeropage, 0xe6),
            (AddressingMode::ZeropageX, 0xf6),
            (AddressingMode::Absolute, 0xee),
            (AddressingMode::AbsoluteX, 0xfe),
        ],
    ),
    ("INX", &[(AddressingMode::Implied, 0xe8)]),
    ("INY", &[(AddressingMode::Implied, 0xc8)]),
    (
        "JMP",
        &[
            (AddressingMode::Absolute, 0x4c),
            (AddressingMode::Indirect, 0x6c),
        ],
    ),
    ("JSR", &[(AddressingMode::Absolute, 0x20)]),
    (
        "LDA",
        &[
            (AddressingMode::Immediate, 0xa9),
            (AddressingMode::Zeropage, 0xa5),
            (AddressingMode::ZeropageX, 0xb5),
            (AddressingMode::Absolute, 0xad),
            (AddressingMode::AbsoluteX, 0xbd),
            (AddressingMode::AbsoluteY, 0xb9),
            (AddressingMode::IndirectX, 0xa1),
            (AddressingMode::IndirectY, 0xb1),
        ],
    ),
    (
        "LDX",
        &[
            (AddressingMode::Immediate, 0xa2),
            (AddressingMode::Zeropage, 0xa6),
            (AddressingMode::ZeropageY, 0xb6),
            (AddressingMode::Absolute, 0xae),
            (AddressingMode::AbsoluteY, 0xbe),
        ],
    ),
    (
        "LDY",
        &[
            (AddressingMode::Immediate, 0xa0),
            (AddressingMode::Zeropage, 0xa4),
            (AddressingMode::ZeropageX, 0xb4),
            (AddressingMode::Absolute, 0xac),
            (AddressingMode::AbsoluteX, 0xbc),
        ],
    ),
    (
        "LSR",
        &[
            (AddressingMode::Accumulator, 0x4a),
            (AddressingMode::Zeropage, 0x46),
            (AddressingMode::ZeropageX, 0x56),
            (AddressingMode::Absolute, 0x4e),
            (AddressingMode::AbsoluteX, 0x5e),
        ],
    ),
    ("NOP", &[(AddressingMode::Implied, 0xea)]),
    (
        "ORA",
        &[
            (AddressingMode::Immediate, 0x09),
            (AddressingMode::Zeropage, 0x05),
            (AddressingMode::ZeropageX, 0x15),
            (AddressingMode::Absolute, 0x0d),
            (AddressingMode::AbsoluteX, 0x1d),
            (AddressingMode::AbsoluteY, 0x19),
            (AddressingMode::IndirectX, 0x01),
            (AddressingMode::IndirectY, 0x11),
        ],
    ),
    ("PHA", &[(AddressingMode::Implied, 0x48)]),
    ("PHP", &[(AddressingMode::Implied, 0x08)]),
    ("PLA", &[(AddressingMode::Implied, 0x68)]),
    ("PLP", &[(AddressingMode::Implied, 0x28)]),
    (
        "ROL",
        &[
            (AddressingMode::Accumulator, 0x2a),
            (AddressingMode::Zeropage, 0x26),
            (AddressingMode::ZeropageX, 0x36),
            (AddressingMode::Absolute, 0x2e),
            (AddressingMode::AbsoluteX, 0x3e),
        ],
    ),
    (
        "ROR",
        &[
            (AddressingMode::Accumulator, 0x6a),
            (AddressingMode::Zeropage, 0x66),
            (AddressingMode::ZeropageX, 0x76),
            (AddressingMode::Absolute, 0x6e),
            (AddressingMode::AbsoluteX, 0x7e),
        ],
    ),
    ("RTI", &[(AddressingMode::Implied, 0x40)]),
    ("RTS", &[(AddressingMode::Implied, 0x60)]),
    (
        "SBC",
        &[
            (AddressingMode::Immediate, 0xe9),
            (AddressingMode::Zeropage, 0xe5),
            (AddressingMode::ZeropageX, 0xf5),
            (AddressingMode::Absolute, 0xed),
            (AddressingMode::AbsoluteX, 0xfd),
            (AddressingMode::AbsoluteY, 0xf9),
            (AddressingMode::IndirectX, 0xe1),
            (AddressingMode::IndirectY, 0xf1),
        ],
    ),
    ("SEC", &[(AddressingMode::Implied, 0x38)]),
    ("SED", &[(AddressingMode::Implied, 0xf8)]),
    ("SEI", &[(AddressingMode::Implied, 0x78)]),
    (
        "STA",
        &[
            (AddressingMode::Zeropage, 0x85),
            (AddressingMode::ZeropageX, 0x95),
            (AddressingMode::Absolute, 0x8d),
            (AddressingMode::AbsoluteX, 0x9d),
            (AddressingMode::AbsoluteY, 0x99),
            (AddressingMode::IndirectX, 0x81),
            (AddressingMode::IndirectY, 0x91),
        ],
    ),
    (
        "STX",
        &[
            (AddressingMode::Zeropage, 0x86),
            (AddressingMode::ZeropageY, 0x96),
            (AddressingMode::Absolute, 0x8e),
        ],
    ),
    (
        "STY",
        &[
            (AddressingMode::Zeropage, 0x84),
            (AddressingMode::ZeropageX, 0x94),
            (AddressingMode::Absolute, 0x8c),
        ],
    ),
    ("TAX", &[(AddressingMode::Implied, 0xaa)]),
    ("TAY", &[(AddressingMode::Implied, 0xa8)]),
    ("TSX", &[(AddressingMode::Implied, 0xba)]),
    ("TXA", &[(AddressingMode::Implied, 0x8a)]),
    ("TXS", &[(AddressingMode::Implied, 0x9a)]),
    ("TYA", &[(AddressingMode::Implied, 0x98)]),
    ("ST0", &[(AddressingMode::Immediate, 0x03)]),
    ("ST1", &[(AddressingMode::Immediate, 0x13)]),
    ("ST2", &[(AddressingMode::Immediate, 0x23)]),
];

/// The opcode byte for one mnemonic and addressing mode, or why not (`encode.ts:132`).
///
/// # Errors
/// An unknown mnemonic, or a mode the mnemonic does not take.
pub fn encode(mnemonic: &str, mode: AddressingMode) -> Result<u8, String> {
    let Some((_, modes)) = OPCODES.iter().find(|(name, _)| *name == mnemonic) else {
        return Err(format!("unknown mnemonic '{mnemonic}'"));
    };
    if let Some((_, opcode)) = modes.iter().find(|(m, _)| *m == mode) {
        return Ok(*opcode);
    }
    let supported = modes
        .iter()
        .map(|(m, _)| m.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "{mnemonic} does not take {} addressing (it takes: {supported})",
        mode.as_str()
    ))
}
