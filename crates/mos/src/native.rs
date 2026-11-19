//! Port of mos/native.ts: native 6502 sources on the machines that link them.
//! `nativePrograms` (the file reading at `native.ts:303-305`) is not ported here.

use crate::asm::assemble::{Directive, Operand};
use crate::asm::encode::instruction_bytes;
use crate::asm::parse::parse_asm;
use crate::chr_nes::NativeSource;
use indexmap::{IndexMap, IndexSet};
use jsnum::{is_js_whitespace, js_trim, parse_int};
use std::collections::HashSet;

/// One size-report row per kept section (`entries` in `NativePrograms`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeEntry {
    pub name: String,
    pub bytes: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativePrograms {
    /// Every `.init.N` section's directives, ascending by N.
    pub init_program: Vec<Directive>,
    /// Every surviving `.text.<symbol>` section's directives.
    pub text_program: Vec<Directive>,
    pub entries: Vec<NativeEntry>,
}

/// A `Directive` list's own byte length (`native.ts:63`).
fn directive_bytes(program: &[Directive]) -> i64 {
    program
        .iter()
        .map(|d| match d {
            Directive::Label { .. } | Directive::Equate { .. } => 0,
            Directive::Byte { values, .. } => values.len() as i64,
            Directive::Instruction { mode, .. } => instruction_bytes(*mode),
        })
        .sum()
}

/// Every label name `program` references as an operand, in first-seen order.
#[must_use]
pub fn referenced_labels(program: &[Directive]) -> IndexSet<String> {
    let mut out = IndexSet::new();
    for d in program {
        if let Directive::Instruction {
            operand: Some(Operand::Label { name, .. }),
            ..
        } = d
        {
            out.insert(name.clone());
        }
    }
    out
}

/// One `.section`'s worth of a native source, parsed and measured.
struct Section {
    path: String,
    name: String,
    directives: Vec<Directive>,
    global_name: Option<String>,
    defines: IndexSet<String>,
    references: IndexSet<String>,
}

/// The comment-stripped, trimmed reading of a line.
fn bare(line: &str) -> &str {
    let cut = [line.find(';'), line.find("//")]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(line.len());
    js_trim(&line[..cut])
}

fn skip_ws(s: &str) -> &str {
    s.trim_start_matches(is_js_whitespace)
}

/// `SECTION_LINE` = `/^\.section\s+([^\s,]+)\s*,\s*"ax"\s*,\s*@progbits$/`: the section name.
fn section_line(line: &str) -> Option<&str> {
    let rest = line.strip_prefix(".section")?;
    let after = skip_ws(rest);
    if after.len() == rest.len() {
        return None;
    }
    let end = after
        .find(|c: char| c == ',' || is_js_whitespace(c))
        .unwrap_or(after.len());
    if end == 0 {
        return None;
    }
    let (name, rest) = after.split_at(end);
    let rest = skip_ws(rest).strip_prefix(',')?;
    let rest = skip_ws(rest).strip_prefix("\"ax\"")?;
    let rest = skip_ws(rest).strip_prefix(',')?;
    (skip_ws(rest) == "@progbits").then_some(name)
}

/// `GLOBAL_LINE` = `/^\.global\s+([A-Za-z_][A-Za-z0-9_]*)$/`: the label name.
fn global_line(line: &str) -> Option<&str> {
    let rest = line.strip_prefix(".global")?;
    let name = skip_ws(rest);
    if name.len() == rest.len() {
        return None;
    }
    let mut chars = name.chars();
    let ok = matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    ok.then_some(name)
}

/// `INIT_SECTION` = `/^\.init\.([0-9]+)$/`: the order number.
fn init_order(name: &str) -> Option<f64> {
    let digits = name.strip_prefix(".init.")?;
    (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
        .then(|| parse_int(digits, 10))
}

/// `TEXT_SECTION` = `/^\.text\.(.+)$/`: the symbol. Section names hold no whitespace, so `.` matches all.
fn text_symbol(name: &str) -> Option<&str> {
    name.strip_prefix(".text.").filter(|s| !s.is_empty())
}

struct Current {
    name: String,
    global_name: Option<String>,
    lines: Vec<String>,
    saw_body: bool,
}

fn finish(
    current: &Option<Current>,
    source: &NativeSource,
    file_index: usize,
    sections: &mut Vec<Section>,
) -> Result<(), String> {
    let Some(current) = current else {
        return Ok(());
    };
    let block_id = format!("native_{file_index}_{}", sections.len());
    let directives = parse_asm(&current.lines.join("\n"), &block_id)
        .map_err(|e| format!("'{}', section '{}': {e}", source.path, current.name))?;
    let mut defines = IndexSet::new();
    for d in &directives {
        let Directive::Label { name, .. } = d else {
            continue;
        };
        if !defines.insert(name.clone()) {
            return Err(format!(
                "'{}': section '{}' defines '{name}' twice",
                source.path, current.name
            ));
        }
    }
    if let Some(global) = &current.global_name
        && !defines.contains(global)
    {
        return Err(format!(
            "'{}': section '{}' declares '.global {global}' but never defines that label",
            source.path, current.name
        ));
    }
    let references = referenced_labels(&directives);
    sections.push(Section {
        path: source.path.clone(),
        name: current.name.clone(),
        directives,
        global_name: current.global_name.clone(),
        defines,
        references,
    });
    Ok(())
}

/// Splits one source into its sections, each body parsed under its own block id.
fn read_sections(source: &NativeSource, file_index: usize) -> Result<Vec<Section>, String> {
    let mut sections: Vec<Section> = Vec::new();
    let mut current: Option<Current> = None;

    for raw in source.text.split('\n') {
        let line = bare(raw);
        if line.is_empty() {
            continue;
        }
        if let Some(name) = section_line(line) {
            finish(&current, source, file_index, &mut sections)?;
            current = Some(Current {
                name: name.to_string(),
                global_name: None,
                lines: Vec::new(),
                saw_body: false,
            });
            continue;
        }
        if line.starts_with(".section") {
            return Err(format!(
                "'{}': '{line}' is not a section directive this native reader understands (only .section NAME,\"ax\",@progbits)",
                source.path
            ));
        }
        let global = global_line(line);
        if global.is_some() || line.starts_with(".global") {
            match (global, current.as_mut()) {
                (Some(name), Some(cur)) if !cur.saw_body && cur.global_name.is_none() => {
                    cur.global_name = Some(name.to_string());
                }
                _ => {
                    return Err(format!(
                        "'{}': '{line}' — a .global must be the one leading line of a section, naming the label it defines",
                        source.path
                    ));
                }
            }
            continue;
        }
        let Some(cur) = current.as_mut() else {
            return Err(format!(
                "'{}': '{line}' sits outside any section — a native source is .section-delimited",
                source.path
            ));
        };
        cur.saw_body = true;
        cur.lines.push(line.to_string());
    }
    finish(&current, source, file_index, &mut sections)?;
    Ok(sections)
}

/// The `.init`/`.text` programs `sources` contribute to one linked build. `referenced` is every
/// label the already-lowered program names.
pub fn assemble_native(
    sources: &[NativeSource],
    referenced: &IndexSet<String>,
) -> Result<NativePrograms, String> {
    let mut sections: Vec<Section> = Vec::new();
    let mut inits: Vec<(f64, usize)> = Vec::new();
    let mut texts: Vec<(String, usize)> = Vec::new();
    let mut owners: IndexMap<String, String> = IndexMap::new();

    for (i, source) in sources.iter().enumerate() {
        for section in read_sections(source, i)? {
            for label in &section.defines {
                if let Some(owner) = owners.get(label) {
                    return Err(format!(
                        "'{}': section '{}' defines '{label}', which '{owner}' already defines",
                        section.path, section.name
                    ));
                }
                owners.insert(
                    label.clone(),
                    format!("{}' section '{}", section.path, section.name),
                );
            }
            let index = sections.len();
            if let Some(order) = init_order(&section.name) {
                inits.push((order, index));
            } else if let Some(symbol) = text_symbol(&section.name) {
                if section.global_name.is_none() && !section.defines.contains(symbol) {
                    return Err(format!(
                        "'{}': section '{}' never defines '{symbol}' — a .text.<symbol> section must define its symbol, or name the label it exports with a leading .global",
                        section.path, section.name
                    ));
                }
                let public = section
                    .global_name
                    .clone()
                    .unwrap_or_else(|| symbol.to_string());
                texts.push((public, index));
            } else {
                return Err(format!(
                    "'{}' has a section '{}' this native reader does not understand: only .init.N and .text.<symbol> are read",
                    section.path, section.name
                ));
            }
            sections.push(section);
        }
    }

    // Stable, like `Array.prototype.sort`: equal N keep source order.
    inits.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    // Mark and sweep to a fixed point.
    let mut reachable: HashSet<&str> = referenced.iter().map(String::as_str).collect();
    for &(_, s) in &inits {
        reachable.extend(sections[s].references.iter().map(String::as_str));
    }
    let mut kept: HashSet<&str> = HashSet::new();
    let mut grew = true;
    while grew {
        grew = false;
        for (symbol, s) in &texts {
            if kept.contains(symbol.as_str()) || !reachable.contains(symbol.as_str()) {
                continue;
            }
            kept.insert(symbol.as_str());
            reachable.extend(sections[*s].references.iter().map(String::as_str));
            grew = true;
        }
    }

    let kept_texts: Vec<usize> = texts
        .iter()
        .filter(|(symbol, _)| kept.contains(symbol.as_str()))
        .map(|&(_, s)| s)
        .collect();

    let kept_sections: Vec<&Section> = inits
        .iter()
        .map(|&(_, s)| s)
        .chain(kept_texts.iter().copied())
        .map(|s| &sections[s])
        .collect();
    let provided: HashSet<&str> = kept_sections
        .iter()
        .flat_map(|s| s.defines.iter().map(String::as_str))
        .collect();
    for section in &kept_sections {
        for name in &section.references {
            if !provided.contains(name.as_str()) {
                return Err(format!(
                    "'{}': section '{}' references '{name}', which no kept native section defines",
                    section.path, section.name
                ));
            }
        }
    }

    let entry_of = |s: &Section| NativeEntry {
        name: format!("(native {})", s.name),
        bytes: directive_bytes(&s.directives),
    };
    let flat = |list: &mut dyn Iterator<Item = &Section>| -> Vec<Directive> {
        list.flat_map(|s| s.directives.iter().cloned()).collect()
    };
    let init_sections: Vec<&Section> = inits.iter().map(|&(_, s)| &sections[s]).collect();
    let text_sections: Vec<&Section> = kept_texts.iter().map(|&s| &sections[s]).collect();
    Ok(NativePrograms {
        init_program: flat(&mut init_sections.iter().copied()),
        text_program: flat(&mut text_sections.iter().copied()),
        entries: init_sections
            .iter()
            .chain(text_sections.iter())
            .map(|s| entry_of(s))
            .collect(),
    })
}
