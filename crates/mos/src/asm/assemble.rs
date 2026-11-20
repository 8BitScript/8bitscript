//! Port of mos/asm/assemble.ts

use super::encode::{AddressingMode, encode, operand_bytes};
use crate::provenance::Provenance;
use indexmap::IndexMap;
use jsnum::{hex_upper, number_to_string};
use serde::{Deserialize, Serialize};

/// Which byte of a label's address an operand takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Half {
    Lo,
    Hi,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Operand {
    Value {
        value: i64,
    },
    Label {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        byte: Option<Half>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset: Option<i64>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Directive {
    Label {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prov: Option<Provenance>,
    },
    Instruction {
        mnemonic: String,
        mode: AddressingMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        operand: Option<Operand>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prov: Option<Provenance>,
    },
    Byte {
        values: Vec<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prov: Option<Provenance>,
    },
    Equate {
        name: String,
        value: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prov: Option<Provenance>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListingLine {
    pub address: i64,
    pub bytes: Vec<i64>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prov: Option<Provenance>,
}

/// A successful assembly (`AssembleResult` with `ok: true`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Assembled {
    pub bytes: Vec<u8>,
    pub listing: Vec<ListingLine>,
    pub labels: IndexMap<String, i64>,
}

/// Where every label lands, or the first problem (`assemble.ts:58`).
fn place_labels(program: &[Directive], origin: i64) -> Result<IndexMap<String, i64>, String> {
    let mut labels: IndexMap<String, i64> = IndexMap::new();
    let mut address = origin;
    for directive in program {
        match directive {
            Directive::Label { name, .. } => {
                if labels.contains_key(name) {
                    return Err(format!("label '{name}' is defined more than once"));
                }
                labels.insert(name.clone(), address);
            }
            Directive::Equate { name, value, .. } => {
                if labels.contains_key(name) {
                    return Err(format!("label '{name}' is defined more than once"));
                }
                if *value < 0 || *value > 0xffff {
                    return Err(format!("equate '{name}' = {value} is not an address"));
                }
                labels.insert(name.clone(), *value);
            }
            Directive::Instruction { mode, .. } => address += 1 + operand_bytes(*mode),
            Directive::Byte { values, .. } => address += values.len() as i64,
        }
    }
    Ok(labels)
}

/// The operand's value, with a label looked up and its offset and half applied (`assemble.ts:81`).
fn resolve(
    operand: Option<&Operand>,
    labels: &IndexMap<String, i64>,
    context: &str,
) -> Result<i64, String> {
    let Some(operand) = operand else {
        return Err(format!("{context} needs an operand"));
    };
    let (name, byte, offset) = match operand {
        Operand::Value { value } => return Ok(*value),
        Operand::Label { name, byte, offset } => (name, byte, offset),
    };
    let Some(found) = labels.get(name) else {
        return Err(format!("{context}: undefined label '{name}'"));
    };
    let value = found + offset.unwrap_or(0);
    if !(0..=0xffff).contains(&value) {
        // R3.9: an absent offset prints as `undefined`.
        let shown = offset.map_or_else(|| "undefined".to_string(), number_to_string_i64);
        return Err(format!(
            "{context}: '{name}' + {shown} is outside the address space"
        ));
    }
    Ok(match byte {
        Some(Half::Lo) => value & 0xff,
        Some(Half::Hi) => (value >> 8) & 0xff,
        None => value,
    })
}

fn number_to_string_i64(v: i64) -> String {
    number_to_string(v as f64)
}

fn hex(value: i64, digits: usize) -> String {
    hex_upper(value, digits)
}

/// Conventional 6502 assembly syntax for one operand, in the mode it was encoded with (`assemble.ts:100`).
fn operand_text(mode: AddressingMode, value: i64) -> String {
    use AddressingMode as M;
    match mode {
        M::Implied => String::new(),
        M::Accumulator => "A".to_string(),
        M::Immediate => format!("#${}", hex(value, 2)),
        M::Zeropage => format!("${}", hex(value, 2)),
        M::ZeropageX => format!("${},X", hex(value, 2)),
        M::ZeropageY => format!("${},Y", hex(value, 2)),
        M::Absolute | M::Relative => format!("${}", hex(value, 4)),
        M::AbsoluteX => format!("${},X", hex(value, 4)),
        M::AbsoluteY => format!("${},Y", hex(value, 4)),
        M::Indirect => format!("(${})", hex(value, 4)),
        M::IndirectX => format!("(${},X)", hex(value, 2)),
        M::IndirectY => format!("(${}),Y", hex(value, 2)),
    }
}

/// Assembles `program`, placed starting at `origin` (`assemble.ts:121`).
///
/// # Errors
/// The first problem found, with the JS text.
pub fn assemble(program: &[Directive], origin: i64) -> Result<Assembled, String> {
    use AddressingMode as M;
    let labels = place_labels(program, origin)?;

    let mut bytes: Vec<u8> = Vec::new();
    let mut listing: Vec<ListingLine> = Vec::new();
    let mut address = origin;

    for directive in program {
        let (mnemonic, mode, operand, prov) = match directive {
            Directive::Label { .. } | Directive::Equate { .. } => continue,
            Directive::Byte { values, prov } => {
                for value in values {
                    if !(0..=0xff).contains(value) {
                        return Err(format!(
                            ".byte {value} at ${} does not fit in one byte",
                            hex(address, 4)
                        ));
                    }
                }
                let shown: Vec<String> =
                    values.iter().map(|v| format!("${}", hex(*v, 2))).collect();
                listing.push(ListingLine {
                    address,
                    bytes: values.clone(),
                    text: format!(".byte {}", shown.join(", ")),
                    prov: prov.clone(),
                });
                // Every value was checked to be 0..=255 above.
                bytes.extend(values.iter().map(|v| *v as u8));
                address += values.len() as i64;
                continue;
            }
            Directive::Instruction {
                mnemonic,
                mode,
                operand,
                prov,
            } => (mnemonic, *mode, operand.as_ref(), prov),
        };

        let context = format!("{mnemonic} at ${}", hex(address, 4));
        let opcode = encode(mnemonic, mode).map_err(|e| format!("{context}: {e}"))?;

        let operand_byte_count = operand_bytes(mode);
        if operand_byte_count == 0 {
            let text = if mode == M::Accumulator {
                format!("{mnemonic} A")
            } else {
                mnemonic.clone()
            };
            listing.push(ListingLine {
                address,
                bytes: vec![i64::from(opcode)],
                text,
                prov: prov.clone(),
            });
            bytes.push(opcode);
            address += 1;
            continue;
        }

        let value = resolve(operand, &labels, &context)?;

        if mode == M::Relative {
            // The offset is relative to the address after this two-byte instruction.
            let delta = value - (address + 2);
            if !(-128..=127).contains(&delta) {
                return Err(format!(
                    "{context}: branch to ${} is {delta} bytes away, out of range (-128..127)",
                    hex(value, 4)
                ));
            }
            let offset = (delta & 0xff) as u8;
            listing.push(ListingLine {
                address,
                bytes: vec![i64::from(opcode), i64::from(offset)],
                text: format!("{mnemonic} {}", operand_text(mode, value)),
                prov: prov.clone(),
            });
            bytes.extend([opcode, offset]);
            address += 2;
            continue;
        }

        if operand_byte_count == 1 {
            if !(0..=0xff).contains(&value) {
                return Err(format!(
                    "{context}: operand ${} does not fit in {}'s one byte",
                    hex(value, 4),
                    mode.as_str()
                ));
            }
            listing.push(ListingLine {
                address,
                bytes: vec![i64::from(opcode), value],
                text: format!("{mnemonic} {}", operand_text(mode, value)),
                prov: prov.clone(),
            });
            bytes.extend([opcode, value as u8]);
            address += 2;
            continue;
        }

        // Two operand bytes, little-endian.
        if !(0..=0xffff).contains(&value) {
            return Err(format!(
                "{context}: operand ${} does not fit in {}'s two bytes",
                hex(value, 4),
                mode.as_str()
            ));
        }
        let lo = value & 0xff;
        let hi = (value >> 8) & 0xff;
        listing.push(ListingLine {
            address,
            bytes: vec![i64::from(opcode), lo, hi],
            text: format!("{mnemonic} {}", operand_text(mode, value)),
            prov: prov.clone(),
        });
        bytes.extend([opcode, lo as u8, hi as u8]);
        address += 3;
    }

    Ok(Assembled {
        bytes,
        listing,
        labels,
    })
}
