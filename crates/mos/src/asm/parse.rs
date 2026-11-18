//! Port of mos/asm/parse.ts: the text of an `asm6502` block, as directives.

use super::assemble::{Directive, Half, Operand};
use super::encode::AddressingMode as Am;
use jsnum::{is_js_whitespace, js_trim, parse_int};

/// Mnemonic to the addressing modes it has, in `OPCODES` order (`encode.ts:44-145`). The parser
/// needs only which modes exist, so this is a private copy of the keys; a test checks it against
/// the table the JS fixture carries. It can be replaced by `encode::OPCODES` once that lands.
static FORMS: &[(&str, &[Am])] = &[
    (
        "ADC",
        &[
            Am::Immediate,
            Am::Zeropage,
            Am::ZeropageX,
            Am::Absolute,
            Am::AbsoluteX,
            Am::AbsoluteY,
            Am::IndirectX,
            Am::IndirectY,
        ],
    ),
    (
        "AND",
        &[
            Am::Immediate,
            Am::Zeropage,
            Am::ZeropageX,
            Am::Absolute,
            Am::AbsoluteX,
            Am::AbsoluteY,
            Am::IndirectX,
            Am::IndirectY,
        ],
    ),
    (
        "ASL",
        &[
            Am::Accumulator,
            Am::Zeropage,
            Am::ZeropageX,
            Am::Absolute,
            Am::AbsoluteX,
        ],
    ),
    ("BCC", &[Am::Relative]),
    ("BCS", &[Am::Relative]),
    ("BEQ", &[Am::Relative]),
    ("BIT", &[Am::Zeropage, Am::Absolute]),
    ("BMI", &[Am::Relative]),
    ("BNE", &[Am::Relative]),
    ("BPL", &[Am::Relative]),
    ("BRK", &[Am::Implied]),
    ("BVC", &[Am::Relative]),
    ("BVS", &[Am::Relative]),
    ("CLC", &[Am::Implied]),
    ("CLD", &[Am::Implied]),
    ("CLI", &[Am::Implied]),
    ("CLV", &[Am::Implied]),
    (
        "CMP",
        &[
            Am::Immediate,
            Am::Zeropage,
            Am::ZeropageX,
            Am::Absolute,
            Am::AbsoluteX,
            Am::AbsoluteY,
            Am::IndirectX,
            Am::IndirectY,
        ],
    ),
    ("CPX", &[Am::Immediate, Am::Zeropage, Am::Absolute]),
    ("CPY", &[Am::Immediate, Am::Zeropage, Am::Absolute]),
    (
        "DEC",
        &[Am::Zeropage, Am::ZeropageX, Am::Absolute, Am::AbsoluteX],
    ),
    ("DEX", &[Am::Implied]),
    ("DEY", &[Am::Implied]),
    (
        "EOR",
        &[
            Am::Immediate,
            Am::Zeropage,
            Am::ZeropageX,
            Am::Absolute,
            Am::AbsoluteX,
            Am::AbsoluteY,
            Am::IndirectX,
            Am::IndirectY,
        ],
    ),
    (
        "INC",
        &[Am::Zeropage, Am::ZeropageX, Am::Absolute, Am::AbsoluteX],
    ),
    ("INX", &[Am::Implied]),
    ("INY", &[Am::Implied]),
    ("JMP", &[Am::Absolute, Am::Indirect]),
    ("JSR", &[Am::Absolute]),
    (
        "LDA",
        &[
            Am::Immediate,
            Am::Zeropage,
            Am::ZeropageX,
            Am::Absolute,
            Am::AbsoluteX,
            Am::AbsoluteY,
            Am::IndirectX,
            Am::IndirectY,
        ],
    ),
    (
        "LDX",
        &[
            Am::Immediate,
            Am::Zeropage,
            Am::ZeropageY,
            Am::Absolute,
            Am::AbsoluteY,
        ],
    ),
    (
        "LDY",
        &[
            Am::Immediate,
            Am::Zeropage,
            Am::ZeropageX,
            Am::Absolute,
            Am::AbsoluteX,
        ],
    ),
    (
        "LSR",
        &[
            Am::Accumulator,
            Am::Zeropage,
            Am::ZeropageX,
            Am::Absolute,
            Am::AbsoluteX,
        ],
    ),
    ("NOP", &[Am::Implied]),
    (
        "ORA",
        &[
            Am::Immediate,
            Am::Zeropage,
            Am::ZeropageX,
            Am::Absolute,
            Am::AbsoluteX,
            Am::AbsoluteY,
            Am::IndirectX,
            Am::IndirectY,
        ],
    ),
    ("PHA", &[Am::Implied]),
    ("PHP", &[Am::Implied]),
    ("PLA", &[Am::Implied]),
    ("PLP", &[Am::Implied]),
    (
        "ROL",
        &[
            Am::Accumulator,
            Am::Zeropage,
            Am::ZeropageX,
            Am::Absolute,
            Am::AbsoluteX,
        ],
    ),
    (
        "ROR",
        &[
            Am::Accumulator,
            Am::Zeropage,
            Am::ZeropageX,
            Am::Absolute,
            Am::AbsoluteX,
        ],
    ),
    ("RTI", &[Am::Implied]),
    ("RTS", &[Am::Implied]),
    (
        "SBC",
        &[
            Am::Immediate,
            Am::Zeropage,
            Am::ZeropageX,
            Am::Absolute,
            Am::AbsoluteX,
            Am::AbsoluteY,
            Am::IndirectX,
            Am::IndirectY,
        ],
    ),
    ("SEC", &[Am::Implied]),
    ("SED", &[Am::Implied]),
    ("SEI", &[Am::Implied]),
    (
        "STA",
        &[
            Am::Zeropage,
            Am::ZeropageX,
            Am::Absolute,
            Am::AbsoluteX,
            Am::AbsoluteY,
            Am::IndirectX,
            Am::IndirectY,
        ],
    ),
    ("STX", &[Am::Zeropage, Am::ZeropageY, Am::Absolute]),
    ("STY", &[Am::Zeropage, Am::ZeropageX, Am::Absolute]),
    ("TAX", &[Am::Implied]),
    ("TAY", &[Am::Implied]),
    ("TSX", &[Am::Implied]),
    ("TXA", &[Am::Implied]),
    ("TXS", &[Am::Implied]),
    ("TYA", &[Am::Implied]),
    ("ST0", &[Am::Immediate]),
    ("ST1", &[Am::Immediate]),
    ("ST2", &[Am::Immediate]),
];

/// `FORMS` lookup by mnemonic (`OPCODES[mnemonic]`).
fn forms_of(mnemonic: &str) -> Option<&'static [Am]> {
    FORMS.iter().find(|(m, _)| *m == mnemonic).map(|(_, f)| *f)
}

const BRANCHES: [&str; 8] = ["BPL", "BMI", "BVC", "BVS", "BCC", "BCS", "BNE", "BEQ"];

/// `/^[A-Za-z_][A-Za-z0-9_]*$/` (`NAMED_LABEL`).
fn is_named(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_ascii_digit())
}

/// `LOCAL_REF` = `/^([0-9]+)([bBfF])$/`: the digits and the direction letter.
fn local_ref(text: &str) -> Option<(&str, char)> {
    let last = text.chars().next_back()?;
    if !matches!(last, 'b' | 'B' | 'f' | 'F') {
        return None;
    }
    let digits = &text[..text.len() - 1];
    all_digits(digits).then_some((digits, last))
}

/// A literal's value (an f64, like JS) and its written digit count.
struct Literal {
    value: f64,
    digits: usize,
}

/// `$FF`, `0xFF`, `%1010`, `42`, or `None` for a symbol.
fn literal(text: &str) -> Option<Literal> {
    let hex = |body: &str| {
        (!body.is_empty() && body.chars().all(|c| c.is_ascii_hexdigit())).then(|| Literal {
            value: parse_int(body, 16),
            digits: body.len(),
        })
    };
    if let Some(body) = text.strip_prefix('$') {
        return hex(body);
    }
    if let Some(body) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        return hex(body);
    }
    if let Some(body) = text.strip_prefix('%') {
        if body.is_empty() || !body.chars().all(|c| c == '0' || c == '1') {
            return None;
        }
        return Some(Literal {
            value: parse_int(body, 2),
            digits: if body.len() > 8 { 4 } else { 2 },
        });
    }
    if all_digits(text) {
        let value = parse_int(text, 10);
        return Some(Literal {
            value,
            digits: if value > 255.0 { 4 } else { 2 },
        });
    }
    None
}

/// `WIDER[mode]`: the absolute twin of a zero-page mode.
fn wider(mode: Am) -> Option<Am> {
    match mode {
        Am::Zeropage => Some(Am::Absolute),
        Am::ZeropageX => Some(Am::AbsoluteX),
        Am::ZeropageY => Some(Am::AbsoluteY),
        _ => None,
    }
}

fn mode_for(mnemonic: &str, preferred: Am) -> Option<Am> {
    let forms = forms_of(mnemonic)?;
    if forms.contains(&preferred) {
        return Some(preferred);
    }
    wider(preferred).filter(|w| forms.contains(w))
}

/// Trailing `,x` / `,y`: the text before the comma (trimmed) and the axis.
fn index_axis(text: &str) -> Option<(&str, char)> {
    let comma = text.rfind(',')?;
    let axis = js_trim(&text[comma + 1..]).to_lowercase();
    let axis = match axis.as_str() {
        "x" => 'x',
        "y" => 'y',
        _ => return None,
    };
    Some((js_trim(&text[..comma]), axis))
}

type Parsed = Result<(Am, Option<Operand>), String>;

fn operand_of(mnemonic: &str, text: &str, context: &str) -> Parsed {
    let fail = |why: String| Err(format!("{context}: {why}"));

    if text.is_empty() {
        return match mode_for(mnemonic, Am::Implied) {
            Some(mode) => Ok((mode, None)),
            None => fail(format!("{mnemonic} needs an operand")),
        };
    }
    if text == "A" || text == "a" {
        return match mode_for(mnemonic, Am::Accumulator) {
            Some(mode) => Ok((mode, None)),
            None => fail(format!("{mnemonic} has no accumulator form")),
        };
    }

    if BRANCHES.contains(&mnemonic) {
        return match local_or_named(text) {
            Some(name) => Ok((Am::Relative, Some(label(name)))),
            None => fail(format!(
                "{mnemonic} needs a label to branch to, got '{text}'"
            )),
        };
    }

    if let Some(body) = text.strip_prefix('#') {
        if let Some(rest) = body.strip_prefix('<').or_else(|| body.strip_prefix('>'))
            && is_named(rest)
        {
            let Some(mode) = mode_for(mnemonic, Am::Immediate) else {
                return fail(format!("{mnemonic} has no immediate form"));
            };
            let byte = if body.starts_with('<') {
                Half::Lo
            } else {
                Half::Hi
            };
            return Ok((
                mode,
                Some(Operand::Label {
                    name: rest.to_string(),
                    byte: Some(byte),
                    offset: None,
                }),
            ));
        }
        let Some(number) = literal(body) else {
            if !is_named(body) {
                return fail(format!("'#{body}' is not an immediate value"));
            }
            let Some(mode) = mode_for(mnemonic, Am::Immediate) else {
                return fail(format!("{mnemonic} has no immediate form"));
            };
            return Ok((mode, Some(label(body.to_string()))));
        };
        if number.value > 255.0 {
            return fail(format!("'#{body}' does not fit in one byte"));
        }
        let Some(mode) = mode_for(mnemonic, Am::Immediate) else {
            return fail(format!("{mnemonic} has no immediate form"));
        };
        return Ok((
            mode,
            Some(Operand::Value {
                value: number.value as i64,
            }),
        ));
    }

    if text.starts_with('(')
        && let Some(close) = text.find(')')
        && close > 0
    {
        let inside = js_trim(&text[1..close]);
        let after = js_trim(&text[close + 1..]);
        if after.is_empty() {
            if let Some((inner, 'x')) = index_axis(inside) {
                return simple(mnemonic, inner, Am::IndirectX, context);
            }
            return simple(mnemonic, inside, Am::Indirect, context);
        }
        if let Some(rest) = after.strip_prefix(',')
            && js_trim(rest).to_lowercase() == "y"
        {
            return simple(mnemonic, inside, Am::IndirectY, context);
        }
    }

    match index_axis(text) {
        Some((body, 'x')) => sized(mnemonic, body, Am::ZeropageX, context),
        Some((body, _)) => sized(mnemonic, body, Am::ZeropageY, context),
        None => sized(mnemonic, text, Am::Zeropage, context),
    }
}

fn label(name: String) -> Operand {
    Operand::Label {
        name,
        byte: None,
        offset: None,
    }
}

/// A mode whose width the mode itself fixes.
fn simple(mnemonic: &str, body: &str, want: Am, context: &str) -> Parsed {
    let Some(mode) = mode_for(mnemonic, want) else {
        return Err(format!(
            "{context}: {mnemonic} has no {} form",
            want.as_str()
        ));
    };
    match operand_value(body) {
        Some(operand) => Ok((mode, Some(operand))),
        None => Err(format!("{context}: '{body}' is not an address or a name")),
    }
}

/// A mode the operand's written width chooses (zero page or absolute).
fn sized(mnemonic: &str, body: &str, narrow: Am, context: &str) -> Parsed {
    let want = match literal(body) {
        Some(number) if number.digits <= 2 => narrow,
        _ => wider(narrow).unwrap_or(narrow),
    };
    let Some(mode) = mode_for(mnemonic, want) else {
        return Err(format!(
            "{context}: {mnemonic} has no {} form",
            want.as_str()
        ));
    };
    match operand_value(body) {
        Some(operand) => Ok((mode, Some(operand))),
        None => Err(format!("{context}: '{body}' is not an address or a name")),
    }
}

/// `/^([A-Za-z_][A-Za-z0-9_]*)\s*\+\s*([0-9]+)$/`: the name and the decimal offset.
fn offset_ref(body: &str) -> Option<(&str, &str)> {
    let end = body
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(body.len());
    let (name, rest) = body.split_at(end);
    if !is_named(name) {
        return None;
    }
    let rest = rest.trim_start_matches(is_js_whitespace);
    let rest = rest.strip_prefix('+')?;
    let digits = rest.trim_start_matches(is_js_whitespace);
    all_digits(digits).then_some((name, digits))
}

fn operand_value(body: &str) -> Option<Operand> {
    if let Some(number) = literal(body) {
        return Some(Operand::Value {
            value: number.value as i64,
        });
    }
    if let Some((name, digits)) = offset_ref(body) {
        return Some(Operand::Label {
            name: name.to_string(),
            byte: None,
            offset: Some(parse_int(digits, 10) as i64),
        });
    }
    local_or_named(body).map(label)
}

fn local_or_named(text: &str) -> Option<String> {
    (local_ref(text).is_some() || is_named(text)).then(|| text.to_string())
}

/// The text before the first `;` or `//`.
fn strip_comment(line: &str) -> &str {
    let cut = [line.find(';'), line.find("//")]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(line.len());
    &line[..cut]
}

/// A leading label, `/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+)\s*:\s*/`: the name and the rest of the line.
fn leading_label(line: &str) -> Option<(&str, &str)> {
    let end = if line.starts_with(|c: char| c.is_ascii_digit()) {
        line.find(|c: char| !c.is_ascii_digit())
    } else if line.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') {
        line.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
    } else {
        return None;
    }
    .unwrap_or(line.len());
    let rest = line[end..].trim_start_matches(is_js_whitespace);
    let rest = rest.strip_prefix(':')?;
    Some((&line[..end], rest.trim_start_matches(is_js_whitespace)))
}

struct Local {
    digit: String,
    name: String,
    at: usize,
}

struct PendingRef {
    digit: String,
    forward: bool,
    at: usize,
    context: String,
}

/// Parses one `asm6502` block. `block_id` makes its local labels its own.
pub fn parse_asm(text: &str, block_id: &str) -> Result<Vec<Directive>, String> {
    let mut out: Vec<Directive> = Vec::new();
    let mut locals: Vec<Local> = Vec::new();
    let mut pending: Vec<PendingRef> = Vec::new();

    for (i, raw) in text.split('\n').enumerate() {
        let mut line = js_trim(strip_comment(raw));
        if line.is_empty() {
            continue;
        }
        let context = format!("asm6502 line {} ('{line}')", i + 1);

        while let Some((name, rest)) = leading_label(line) {
            if all_digits(name) {
                let unique = format!("__asm_{block_id}_{name}_{}", locals.len());
                locals.push(Local {
                    digit: name.to_string(),
                    name: unique.clone(),
                    at: out.len(),
                });
                out.push(Directive::Label {
                    name: unique,
                    prov: None,
                });
            } else {
                out.push(Directive::Label {
                    name: name.to_string(),
                    prov: None,
                });
            }
            line = js_trim(rest);
        }
        if line.is_empty() {
            continue;
        }

        let at = line.find([' ', '\t']).unwrap_or(line.len());
        let written = &line[..at];
        let mnemonic = written.to_uppercase();
        if forms_of(&mnemonic).is_none() {
            return Err(format!("{context}: '{written}' is not a 6502 instruction"));
        }
        let (mode, operand) = operand_of(&mnemonic, js_trim(&line[at..]), &context)?;

        if let Some(Operand::Label { name, .. }) = &operand
            && let Some((digit, dir)) = local_ref(name)
        {
            pending.push(PendingRef {
                digit: digit.to_string(),
                forward: dir.eq_ignore_ascii_case(&'f'),
                at: out.len(),
                context: context.clone(),
            });
        }
        out.push(Directive::Instruction {
            mnemonic,
            mode,
            operand,
            prov: None,
        });
    }

    for r in &pending {
        let mut candidates = locals.iter().filter(|l| l.digit == r.digit);
        let target = if r.forward {
            candidates.find(|l| l.at > r.at)
        } else {
            candidates.rev().find(|l| l.at <= r.at)
        };
        let Some(target) = target else {
            return Err(format!(
                "{}: no label '{}:' {} it",
                r.context,
                r.digit,
                if r.forward { "after" } else { "before" }
            ));
        };
        if let Directive::Instruction {
            operand: Some(Operand::Label { name, .. }),
            ..
        } = &mut out[r.at]
        {
            name.clone_from(&target.name);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The private `FORMS` copy must match the keys of `OPCODES`, in order, as the JS fixture has them.
    #[test]
    fn forms_match_the_js_opcode_table() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/parse.json")).unwrap();
        let rows = fixture["opcodes"].as_array().unwrap();
        assert_eq!(rows.len(), FORMS.len());
        for (row, (mnemonic, modes)) in rows.iter().zip(FORMS) {
            assert_eq!(row[0].as_str().unwrap(), *mnemonic);
            let want: Vec<&str> = row[1]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m.as_str().unwrap())
                .collect();
            let have: Vec<&str> = modes.iter().map(|m| m.as_str()).collect();
            assert_eq!(want, have, "{mnemonic}");
        }
    }

    /// K1: a literal of 2^63 or more saturates as an i64 here (an f64 in JS). Only the
    /// error text differs, so this pins the Rust behaviour.
    #[test]
    fn k1_literal_at_or_above_2_pow_63_saturates() {
        let out = parse_asm("sta 9223372036854775808", "t").unwrap();
        let Directive::Instruction { operand, .. } = &out[0] else {
            panic!("instruction")
        };
        assert_eq!(*operand, Some(Operand::Value { value: i64::MAX }));
        let err = parse_asm("lda #99999999999999999999", "t").unwrap_err();
        assert_eq!(
            err,
            "asm6502 line 1 ('lda #99999999999999999999'): '#99999999999999999999' does not fit in one byte"
        );
    }
}
