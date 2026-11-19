//! Port of mos/asm/relax.ts
//!
//! When a relative branch `assemble` refuses for being out of range, rewrite it as an
//! inverted branch over a JMP and try again, until the program assembles.

use super::assemble::{Assembled, Directive, Operand, assemble};
use super::encode::{AddressingMode, operand_bytes};
use crate::build::Counters;
use crate::provenance::{Generated, Provenance};
use regex::Regex;
use std::sync::OnceLock;

/// The branch that fires on the opposite condition (`relax.ts:25`).
fn inverse(mnemonic: &str) -> Option<&'static str> {
    Some(match mnemonic {
        "BEQ" => "BNE",
        "BNE" => "BEQ",
        "BCC" => "BCS",
        "BCS" => "BCC",
        "BVC" => "BVS",
        "BVS" => "BVC",
        "BPL" => "BMI",
        "BMI" => "BPL",
        _ => return None,
    })
}

/// `relax.ts:29`, with ASCII classes (R6.2).
fn out_of_range() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^([A-Za-z0-9_]+) at \$([0-9A-F]{4}): branch to ").expect("static regex")
    })
}

/// Long enough that a real program never hits it, short enough to fail fast (`relax.ts:34`).
const MAX_PASSES: usize = 64;

/// How many bytes a directive occupies once placed (`relax.ts:37`).
fn directive_bytes(directive: &Directive) -> i64 {
    match directive {
        Directive::Label { .. } | Directive::Equate { .. } => 0,
        Directive::Byte { values, .. } => values.len() as i64,
        Directive::Instruction { mode, .. } => 1 + operand_bytes(*mode),
    }
}

/// Rewrites the one relative-mode instruction at `target_address` into an inverted branch
/// over a JMP, or returns `None` if none sits there (`relax.ts:50`).
fn relax_one(
    program: &[Directive],
    origin: i64,
    target_address: i64,
    inverse: &str,
    c: &mut Counters,
) -> Option<Vec<Directive>> {
    let mut out: Vec<Directive> = Vec::new();
    let mut address = origin;
    let mut relaxed = false;

    for directive in program {
        if !relaxed
            && let Directive::Instruction {
                mode: AddressingMode::Relative,
                operand,
                prov: directive_prov,
                ..
            } = directive
            && address == target_address
        {
            let skip = format!("__8bs_relax_{}", c.relax);
            c.relax += 1;
            // The pieces inherit the original branch's source; `generated` says why.
            let prov = directive_prov.as_ref().map(|p| Provenance {
                generated: Some(Generated {
                    reason: "branch-relaxation".to_string(),
                }),
                ..p.clone()
            });
            out.push(Directive::Instruction {
                mnemonic: inverse.to_string(),
                mode: AddressingMode::Relative,
                operand: Some(Operand::Label {
                    name: skip.clone(),
                    byte: None,
                    offset: None,
                }),
                prov: prov.clone(),
            });
            out.push(Directive::Instruction {
                mnemonic: "JMP".to_string(),
                mode: AddressingMode::Absolute,
                operand: operand.clone(),
                prov,
            });
            out.push(Directive::Label {
                name: skip,
                prov: directive_prov.clone(),
            });
            relaxed = true;
            continue;
        }
        out.push(directive.clone());
        address += directive_bytes(directive);
    }

    relaxed.then_some(out)
}

/// `assemble`, but a relative branch too far away is rewritten to a long form and retried
/// (`relax.ts:80`).
///
/// # Errors
/// The `assemble` error, or the pass-limit text.
pub fn assemble_relaxed(
    program: &[Directive],
    origin: i64,
    c: &mut Counters,
) -> Result<Assembled, String> {
    let mut owned: Option<Vec<Directive>> = None;
    for _ in 0..MAX_PASSES {
        let current = owned.as_deref().unwrap_or(program);
        let error = match assemble(current, origin) {
            Ok(done) => return Ok(done),
            Err(error) => error,
        };

        let Some(found) = out_of_range().captures(&error) else {
            return Err(error); // not a branch-range problem
        };
        let Some(inverse) = inverse(&found[1]) else {
            return Err(error);
        };

        let at = jsnum::parse_int(&found[2], 16) as i64;
        let Some(relaxed) = relax_one(current, origin, at, inverse, c) else {
            return Err(error);
        };
        owned = Some(relaxed);
    }
    Err(format!(
        "assembleRelaxed: branches still out of range after {MAX_PASSES} relaxation passes \u{2014} a genuine bug, not a program this large"
    ))
}
