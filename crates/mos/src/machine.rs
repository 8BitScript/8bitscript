//! Port of mos/index.ts (the machine tables and the helpers `build()` uses).

use indexmap::{IndexMap, IndexSet};
use mos_ir::{Function, HardwareBuild, Stmt};
use serde::Serialize;
use serde_json::Value;

use crate::asm::assemble::{Directive, Operand};
use crate::asm::encode::{AddressingMode, instruction_bytes};
use crate::build::Machine;
use crate::walk::{Flow, Node, visit_body};
use crate::zp::{Budget, ZpHole};

/// `CpuVariant`: the instruction-set variant of a machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CpuVariant {
    pub core: &'static str,
    pub decimal_mode: bool,
    pub jmp_indirect_page_bug: bool,
    pub extra_opcodes: &'static [&'static str],
    pub undocumented_opcodes: bool,
}

const NONE: &[&str] = &[];
const CMOS: &[&str] = &["STZ", "BRA", "PHX", "PHY", "PLX", "PLY", "TRB", "TSB"];
const MEGA65_EXTRA: &[&str] = &[
    "STZ", "BRA", "PHX", "PHY", "PLX", "PLY", "TRB", "TSB", "INW", "DEW",
];
const PCE_EXTRA: &[&str] = &[
    "STZ", "BRA", "PHX", "PHY", "PLX", "PLY", "TRB", "TSB", "ST0", "ST1", "ST2",
];

const fn cpu(
    core: &'static str,
    jmp_indirect_page_bug: bool,
    extra_opcodes: &'static [&'static str],
    undocumented_opcodes: bool,
) -> CpuVariant {
    CpuVariant {
        core,
        decimal_mode: true,
        jmp_indirect_page_bug,
        extra_opcodes,
        undocumented_opcodes,
    }
}

/// The instruction-set variant each machine runs, in the literal order of
/// `CPU`. Data, not logic (T2).
pub static CPU: [(Machine, CpuVariant); 18] = [
    (Machine::Vic20, cpu("6502", true, NONE, false)),
    (Machine::Pet, cpu("6502", true, NONE, false)),
    (Machine::C64, cpu("6510", true, NONE, false)),
    (Machine::C128, cpu("8502", true, NONE, false)),
    (Machine::Cx16, cpu("65C02", false, CMOS, false)),
    (Machine::Mega65, cpu("45GS10", false, MEGA65_EXTRA, false)),
    (
        Machine::Nes,
        CpuVariant {
            core: "2A03",
            decimal_mode: false,
            jmp_indirect_page_bug: true,
            extra_opcodes: NONE,
            undocumented_opcodes: false,
        },
    ),
    (Machine::Atari8, cpu("6502", true, NONE, true)),
    (Machine::Plus4, cpu("6502", true, NONE, false)),
    (Machine::Oric, cpu("6502", true, NONE, false)),
    (Machine::Apple2, cpu("6502", true, NONE, false)),
    (Machine::Bbc, cpu("65C02", false, CMOS, false)),
    (Machine::Atari5200, cpu("6502", true, NONE, true)),
    (Machine::Lynx, cpu("65C02", false, CMOS, false)),
    (Machine::Pce, cpu("65C02", false, PCE_EXTRA, false)),
    (Machine::Supervision, cpu("65C02", false, CMOS, false)),
    (Machine::Atari2600, cpu("6502", true, NONE, false)),
    (Machine::Atari7800, cpu("6502", true, NONE, false)),
];

/// The variant `machine` runs. Every machine has a row, so this never misses.
#[must_use]
pub fn cpu_of(machine: Machine) -> &'static CpuVariant {
    CPU.iter()
        .find(|(m, _)| *m == machine)
        .map_or(&CPU[0].1, |(_, v)| v)
}

/// `CHRGET_BYTES`.
const CHRGET_BYTES: f64 = 24.0;

/// A zero-page budget with no holes (the JS omits `holes` then).
const fn budget(zp_origin: i64, zp_ceiling: i64) -> Budget {
    Budget {
        zp_origin,
        zp_ceiling,
        holes: Vec::new(),
    }
}

/// The machines `ZP_BUDGETS` has a row for, in its literal key order (the
/// refusal text of `build()` lists them).
pub static ZP_BUDGET_MACHINES: [Machine; 18] = [
    Machine::Pet,
    Machine::C64,
    Machine::Vic20,
    Machine::C128,
    Machine::Cx16,
    Machine::Mega65,
    Machine::Atari8,
    Machine::Nes,
    Machine::Plus4,
    Machine::Oric,
    Machine::Apple2,
    Machine::Bbc,
    Machine::Atari5200,
    Machine::Lynx,
    Machine::Pce,
    Machine::Supervision,
    Machine::Atari2600,
    Machine::Atari7800,
];

/// Per machine, `(polite, owned)`: the budget a program that returns to BASIC
/// may take, and the one a program that never does may take (`ZP_BUDGETS`).
/// `None` for a machine with no row.
#[must_use]
pub fn zp_budgets(machine: Machine) -> Option<(Budget, Budget)> {
    // PET_ZP_BUDGET, PET_OWNED_ZP_BUDGET, VIC20_ZP_BUDGET, C128_ZP_BUDGET,
    // MEGA65_ZP_BUDGET and OWNED_ZP: `$02`-`$100` (`$0A` on the C128).
    let pet = || budget(0x02, 0x100);
    let c64 = || budget(0x02, 0xfd);
    let atari8 = || budget(0x80, 0x100);
    let nes = || budget(0x00, 0x100);
    Some(match machine {
        Machine::Pet | Machine::Vic20 | Machine::Mega65 => (pet(), pet()),
        Machine::C64 => (c64(), c64()),
        Machine::C128 => (budget(0x0a, 0x100), budget(0x0a, 0x100)),
        Machine::Cx16 => (
            budget(0x22, 0x80),
            Budget {
                zp_origin: 0x22,
                zp_ceiling: 0x100,
                holes: vec![ZpHole {
                    start: 0x80,
                    end: 0xa9,
                }],
            },
        ),
        Machine::Atari8 | Machine::Atari5200 | Machine::Atari2600 => (atari8(), atari8()),
        Machine::Nes | Machine::Lynx | Machine::Pce | Machine::Supervision | Machine::Atari7800 => {
            (nes(), nes())
        }
        Machine::Plus4 | Machine::Oric | Machine::Apple2 | Machine::Bbc => (pet(), pet()),
    })
}

/// The machines whose program borrows the zero page it uses and gives it back
/// (`BORROWS_ZERO_PAGE`).
pub static BORROWS_ZERO_PAGE: [Machine; 2] = [Machine::Pet, Machine::Vic20];

/// The machines with a waitFrame() runtime of their own (`RASTER_MACHINES`).
pub static RASTER_MACHINES: [Machine; 17] = [
    Machine::C64,
    Machine::Vic20,
    Machine::C128,
    Machine::Cx16,
    Machine::Mega65,
    Machine::Nes,
    Machine::Atari8,
    Machine::Plus4,
    Machine::Oric,
    Machine::Apple2,
    Machine::Bbc,
    Machine::Atari5200,
    Machine::Lynx,
    Machine::Pce,
    Machine::Supervision,
    Machine::Atari2600,
    Machine::Atari7800,
];

/// The CHRGET hole a machine sheet names with `memory.chrget`, when it falls
/// inside `budget` (`chrgetZpHoles`). `typeof chrget !==
/// 'number'` is `Value::is_number`.
#[must_use]
pub fn chrget_zp_holes(facts: &IndexMap<String, Value>, budget: &Budget) -> Vec<ZpHole> {
    let Some(chrget) = facts.get("memory.chrget").and_then(Value::as_f64) else {
        return Vec::new();
    };
    let start = chrget;
    let end = chrget + CHRGET_BYTES;
    if end <= budget.zp_origin as f64 || start >= budget.zp_ceiling as f64 {
        return Vec::new();
    }
    vec![ZpHole {
        start: start as i64,
        end: end as i64,
    }]
}

/// The file extension a build for this machine and hardware produces
/// (`outputExtension`).
#[must_use]
pub fn output_extension(machine: Machine, hardware: Option<&HardwareBuild>) -> String {
    if let Some(output) = hardware.and_then(|h| h.output.as_deref())
        && !output.is_empty()
    {
        return output.to_string();
    }
    match machine {
        Machine::Nes => "nes".to_string(),
        Machine::Atari8 => "xex".to_string(),
        _ => "prg".to_string(),
    }
}

/// Every name `body` (or anything nested under it) calls, in first-seen order
/// (`collectCallNames`).
pub fn collect_call_names(body: &[Stmt], out: &mut IndexSet<String>) {
    visit_body(body, &mut |node| {
        if let Some(call) = node.as_call() {
            out.insert(call.name.clone());
        }
        Flow::Continue
    });
}

/// The first call cycle found in `functions`' own call graph, as the chain of
/// names involved, or `None` if the graph is a DAG (`findCallCycle`).
#[must_use]
pub fn find_call_cycle(functions: &[Function]) -> Option<Vec<String>> {
    let mut callees: IndexMap<String, IndexSet<String>> = IndexMap::new();
    for function in functions {
        let mut out = IndexSet::new();
        collect_call_names(&function.body, &mut out);
        callees.insert(function.name.clone(), out);
    }
    let mut state: IndexMap<String, bool> = IndexMap::new(); // false: visiting, true: done
    let mut stack: Vec<String> = Vec::new();
    for function in functions {
        if let Some(found) = visit(&function.name, &callees, &mut state, &mut stack) {
            return Some(found);
        }
    }
    None
}

fn visit(
    name: &str,
    callees: &IndexMap<String, IndexSet<String>>,
    state: &mut IndexMap<String, bool>,
    stack: &mut Vec<String>,
) -> Option<Vec<String>> {
    match state.get(name) {
        Some(true) => return None,
        Some(false) => {
            let at = stack.iter().position(|s| s == name).unwrap_or(0);
            return Some(stack[at..].to_vec());
        }
        None => {}
    }
    state.insert(name.to_string(), false);
    stack.push(name.to_string());
    if let Some(set) = callees.get(name) {
        for callee in set {
            if !callees.contains_key(callee) {
                continue; // not one of this program's own functions
            }
            if let Some(found) = visit(callee, callees, state, stack) {
                return Some(found);
            }
        }
    }
    stack.pop();
    state.insert(name.to_string(), true);
    None
}

fn ins(mnemonic: &str, mode: AddressingMode, operand: Option<Operand>) -> Directive {
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

fn label(name: &str, offset: Option<i64>) -> Option<Operand> {
    Some(Operand::Label {
        name: name.to_string(),
        byte: None,
        offset,
    })
}

fn label_def(name: &str) -> Directive {
    Directive::Label {
        name: name.to_string(),
        prov: None,
    }
}

/// Zeroes `[origin, end)`, the RAM window mutable arrays were placed in on a
/// machine whose image is a ROM (`clearRam`).
#[must_use]
pub fn clear_ram(origin: i64, end: i64) -> Vec<Directive> {
    let size = end - origin;
    if size <= 0 {
        return Vec::new();
    }
    let mut out = vec![lda_imm(0)];
    let pages = size.div_euclid(256);
    for page in 0..pages {
        let loop_label = format!("__8bs_ram_clear_{page}");
        out.push(ins("LDX", AddressingMode::Immediate, value(0)));
        out.push(label_def(&loop_label));
        out.push(ins(
            "STA",
            AddressingMode::AbsoluteX,
            value(origin + page * 256),
        ));
        out.push(ins("INX", AddressingMode::Implied, None));
        out.push(ins(
            "BNE",
            AddressingMode::Relative,
            label(&loop_label, None),
        ));
    }
    let tail = size - pages * 256;
    if tail > 0 {
        // X counts down from `tail`, so the store at offset 0 is the last one.
        let loop_label = "__8bs_ram_clear_tail";
        out.push(ins("LDX", AddressingMode::Immediate, value(tail)));
        out.push(label_def(loop_label));
        out.push(ins("DEX", AddressingMode::Implied, None));
        out.push(ins(
            "STA",
            AddressingMode::AbsoluteX,
            value(origin + pages * 256),
        ));
        out.push(ins(
            "BNE",
            AddressingMode::Relative,
            label(loop_label, None),
        ));
    }
    out
}

/// Copies `size` bytes from the label `from` into RAM at `to` (`copyToRam`).
#[must_use]
pub fn copy_to_ram(from: &str, to: i64, size: i64, tag: &str) -> Vec<Directive> {
    let mut out = Vec::new();
    let pages = size.div_euclid(256);
    let mut mv = |loop_label: &str, offset: i64, end: Vec<Directive>| {
        out.push(ins("LDX", AddressingMode::Immediate, value(0)));
        out.push(label_def(loop_label));
        out.push(ins(
            "LDA",
            AddressingMode::AbsoluteX,
            label(from, Some(offset)),
        ));
        out.push(ins("STA", AddressingMode::AbsoluteX, value(to + offset)));
        out.push(ins("INX", AddressingMode::Implied, None));
        out.extend(end);
        out.push(ins(
            "BNE",
            AddressingMode::Relative,
            label(loop_label, None),
        ));
    };
    for page in 0..pages {
        mv(&format!("{tag}_{page}"), page * 256, Vec::new());
    }
    let tail = size - pages * 256;
    if tail > 0 {
        mv(
            &format!("{tag}_tail"),
            pages * 256,
            vec![ins("CPX", AddressingMode::Immediate, value(tail))],
        );
    }
    out
}

/// `RTS`.
#[must_use]
pub fn rts() -> Directive {
    ins("RTS", AddressingMode::Implied, None)
}

/// `ldaImm`.
#[must_use]
pub fn lda_imm(v: i64) -> Directive {
    ins("LDA", AddressingMode::Immediate, value(v))
}

/// `staZp`.
#[must_use]
pub fn sta_zp(address: i64) -> Directive {
    ins("STA", AddressingMode::Zeropage, value(address))
}

/// A directive list's own byte length (`directiveBytes`).
#[must_use]
pub fn directive_bytes(program: &[Directive]) -> i64 {
    let mut total = 0;
    for d in program {
        match d {
            Directive::Label { .. } | Directive::Equate { .. } => {}
            Directive::Byte { values, .. } => total += values.len() as i64,
            Directive::Instruction { mode, .. } => total += instruction_bytes(*mode),
        }
    }
    total
}

/// One named piece of a build's size report (`SizeReportEntry`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SizeReportEntry {
    pub name: String,
    pub bytes: i64,
}

/// One part of a lowered function: `origin` names the inlined callee it came from.
#[derive(Clone, Copy, Debug)]
pub struct SizePart<'a> {
    pub origin: Option<&'a str>,
    pub program: &'a [Directive],
}

/// The size entries of one function, merged by origin in first-seen order
/// (`functionSizeEntries`). A non-entry function appends a
/// one-byte `RTS` after its body.
#[must_use]
pub fn function_size_entries(
    name: &str,
    parts: &[SizePart<'_>],
    is_entry: bool,
) -> Vec<SizeReportEntry> {
    let mut merged: IndexMap<String, i64> = IndexMap::new();
    for part in parts {
        let key = part.origin.unwrap_or(name).to_string();
        let bytes = directive_bytes(part.program);
        *merged.entry(key).or_insert(0) += bytes;
    }
    if !is_entry {
        *merged.entry(name.to_string()).or_insert(0) += 1;
    }
    merged
        .into_iter()
        .map(|(name, bytes)| SizeReportEntry { name, bytes })
        .collect()
}

/// Every string-literal slot `body` uses (`collectStringIndexes`).
pub fn collect_string_indexes(body: &[Stmt], out: &mut IndexSet<i64>) {
    visit_body(body, &mut |node| {
        if let Node::Expr(mos_ir::Expr::String(s)) = node {
            out.insert(s.index);
        }
        Flow::Continue
    });
}
