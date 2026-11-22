//! Port of mos/index.ts (`build`)

use serde::{Deserialize, Serialize};

/// Variant order follows `mos/index.ts:55`; serde names are the JS strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Machine {
    Vic20,
    C64,
    Pet,
    C128,
    Mega65,
    Cx16,
    Nes,
    Atari8,
    Plus4,
    Oric,
    Apple2,
    Bbc,
    Atari5200,
    Lynx,
    Pce,
    Supervision,
    Atari2600,
    Atari7800,
}

impl Machine {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vic20 => "vic20",
            Self::C64 => "c64",
            Self::Pet => "pet",
            Self::C128 => "c128",
            Self::Mega65 => "mega65",
            Self::Cx16 => "cx16",
            Self::Nes => "nes",
            Self::Atari8 => "atari8",
            Self::Plus4 => "plus4",
            Self::Oric => "oric",
            Self::Apple2 => "apple2",
            Self::Bbc => "bbc",
            Self::Atari5200 => "atari5200",
            Self::Lynx => "lynx",
            Self::Pce => "pce",
            Self::Supervision => "supervision",
            Self::Atari2600 => "atari2600",
            Self::Atari7800 => "atari7800",
        }
    }
}

/// The two module-level label counters (R4.6); `build()` creates it zeroed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    pub lower: u64,
    pub relax: u64,
}

// ---- build (mos/index.ts:749-1413) -----------------------------------------

use crate::asm::assemble::{Directive, Operand};
use crate::asm::encode::AddressingMode;
use crate::chr_nes::NativeSource;
use crate::data::{DataArrayGlobal, IrString, array_label, build_data_section};
use crate::image::{ChrPatch, ImageExtras, image_for};
use crate::link::{LinkInput, Linked, SectionContent, link};
use crate::lower::LocalAllocator;
use crate::lower::{
    ArrayInfo, Binding, FunctionSite, LowerOptions, ParamBinding, SiteParam, lower,
};
use crate::machine::{
    BORROWS_ZERO_PAGE, RASTER_MACHINES, SizePart, SizeReportEntry, chrget_zp_holes, clear_ram,
    collect_string_indexes, copy_to_ram, directive_bytes, find_call_cycle, function_size_entries,
    lda_imm, rts, sta_zp, zp_budgets,
};
use crate::native::{assemble_native, referenced_labels};
use crate::startup::commodore::{
    borrow_zero_page, epilogue, prologue, return_zero_page, uses_decimal_sensitive_math,
    zero_page_save_data,
};
use crate::startup::multiply::{
    MULTIPLY_ZP_BYTES, MultiplyCells, multiply_cells, multiply_routine, uses_multiply,
};
use crate::startup::nes::nes_reset_init;
use crate::startup::waitframe::{
    WAIT_FRAME_ZP_BYTES, frame_edge_wait, uses_wait_frame, wait_frame_keeps_interrupts,
    wait_frame_routine, wait_frame_setup,
};
use crate::types::storage_bytes;
use crate::zp::frames::{FrameNeed, layout_frames};
use crate::zp::{Budget, IrGlobal, PlaceZp, Storage, ZpHole, allocate, place_zp};
use indexmap::{IndexMap, IndexSet};
use jsnum::{Nullable, hex_upper, to_int32};
use mos_ir::{BackendInput, GlobalInit};

/// What a build returns: the link result, the file, and the size report when asked for.
#[derive(Clone, Debug)]
pub struct BuildOutput {
    pub link: Linked,
    pub bytes: Vec<u8>,
    pub size_report: Option<Vec<SizeReportEntry>>,
}

/// A refusal: the JS `error` text, byte for byte. `link` is set when the link had already
/// succeeded (the image step refuses after `dump('link')`).
#[derive(Clone, Debug)]
pub struct BuildError {
    pub message: String,
    pub link: Option<Box<Linked>>,
}

impl From<String> for BuildError {
    fn from(message: String) -> Self {
        Self {
            message,
            link: None,
        }
    }
}

impl std::fmt::Display for BuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

fn refuse<T>(message: impl Into<String>) -> Result<T, BuildError> {
    Err(BuildError::from(message.into()))
}

/// `(init & 0xff)` and `((init >> 8) & 0xff)` on a JS number.
fn low_byte(v: i64) -> i64 {
    i64::from(to_int32(v as f64) & 0xff)
}

fn high_byte(v: i64) -> i64 {
    i64::from((to_int32(v as f64) >> 8) & 0xff)
}

fn instruction(mnemonic: &str, mode: AddressingMode, operand: Option<Operand>) -> Directive {
    Directive::Instruction {
        mnemonic: mnemonic.to_string(),
        mode,
        operand,
        prov: None,
    }
}

fn label_directive(name: &str) -> Directive {
    Directive::Label {
        name: name.to_string(),
        prov: None,
    }
}

/// `Object.keys(ZP_BUDGETS).join(', ')`, in the JS key order.
const ZP_BUDGET_MACHINES: &str = "pet, c64, vic20, c128, cx16, mega65, atari8, nes, plus4, oric, apple2, bbc, atari5200, lynx, pce, supervision, atari2600, atari7800";

/// One lowered function (`loweredFunctions` entries).
struct LoweredFunction {
    name: String,
    label: String,
    program: Vec<Directive>,
    parts: Vec<crate::lower::Part>,
    is_entry: bool,
}

/// One function's parameter widths and 16-bit return width (`FrameShape`).
struct FrameShape {
    param_widths: Vec<i64>,
    return_width: i64,
}

/// Reads the native sources off disk (`nativePrograms`' own `readFileSync`).
fn read_native(paths: &[String], roots: &oracle::Roots) -> Result<Vec<NativeSource>, BuildError> {
    let mut sources = Vec::new();
    for tokenized in paths {
        let path = oracle::detokenize_path(tokenized, roots);
        let text = std::fs::read(&path)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .map_err(|_| BuildError::from(format!("cannot read {tokenized}")))?;
        sources.push(NativeSource { path, text });
    }
    Ok(sources)
}

/// Lowers `input` to machine code and links it (`buildProgram` after its dump).
///
/// # Errors
/// The JS `error` text of the first refusal.
#[allow(clippy::too_many_lines)]
pub fn build(input: &BackendInput, roots: &oracle::Roots) -> Result<BuildOutput, BuildError> {
    let mut c = Counters::default();
    let budgets =
        serde_json::from_value::<Machine>(serde_json::Value::String(input.machine.clone()))
            .ok()
            .and_then(|m| zp_budgets(m).map(|b| (m, b)));
    let Some((machine, (polite, owned))) = budgets else {
        return refuse(format!(
            "the {} is not a target this backend builds yet: it has no zero-page budget on the sheet, so there is nowhere to put a program's globals. The native 6502 backend is being brought up one machine at a time — {} so far",
            input.machine, ZP_BUDGET_MACHINES
        ));
    };
    let machine_name = machine.as_str();
    let defsym = &input.hardware.build.defsym;
    let Some(&load_address) = defsym.get("__load_address") else {
        return refuse(format!(
            "the {machine_name} hardware sheet is missing defsym.__load_address, the address its .prg loads at and the BASIC stub's SYS jumps into"
        ));
    };
    if let Some(driver) = input
        .hardware
        .build
        .startup
        .as_deref()
        .filter(|s| s.starts_with("cart-"))
    {
        return refuse(format!(
            "this {machine_name} build asks for the '{driver}' cartridge start-up driver, and the native 6502 backend has none: it builds the one shape the machine's disk media has, loaded at ${}. Pick a media value that loads rather than one that plugs in",
            hex_upper(load_address, 0)
        ));
    }
    if !input.functions.iter().any(|f| f.name == input.entry) {
        return refuse(format!(
            "the linked entry point '{}' names no function in ir.functions",
            input.entry
        ));
    }

    let functions = &input.functions;
    let globals = &input.globals;
    let origin_files = &input.origin_files;

    if let Some(cycle) = find_call_cycle(functions) {
        return refuse(format!(
            "recursion isn't lowered yet: {} -> {} calls itself, directly or through another function",
            cycle.join(" -> "),
            cycle[0]
        ));
    }

    let needs_wait_frame = uses_wait_frame(functions);
    if needs_wait_frame && !RASTER_MACHINES.contains(&machine) && machine != Machine::Pet {
        return refuse(format!(
            "waitFrame() has no runtime on the {machine_name} yet: its frame sync is the PET's VIA retrace flag, and the {machine_name}'s own raster poll is not written. A program that draws once and returns builds today; one that paces itself does not"
        ));
    }
    let zp_budget: Budget = if needs_wait_frame { owned } else { polite };

    let mut zp_holes: Vec<ZpHole> = zp_budget.holes.clone();
    if !needs_wait_frame {
        zp_holes.extend(chrget_zp_holes(&input.hardware.facts, &zp_budget));
    }
    let ir_globals: Vec<IrGlobal> = globals
        .iter()
        .map(|g| IrGlobal {
            name: g.name.clone(),
            ty: g.ty.clone(),
            address: g.address,
            array: g.array,
            constant: g.constant,
            init: Nullable::Absent,
        })
        .collect();
    let zp = allocate(
        &ir_globals,
        &Budget {
            holes: zp_holes.clone(),
            ..zp_budget.clone()
        },
    )?;

    let global_types: IndexMap<&str, &str> = globals
        .iter()
        .map(|g| (g.name.as_str(), g.ty.as_str()))
        .collect();
    let global_bindings: IndexMap<String, Binding> = zp
        .globals
        .iter()
        .map(|g| {
            (
                g.name.clone(),
                Binding {
                    address: g.address,
                    ty: global_types
                        .get(g.name.as_str())
                        .copied()
                        .unwrap_or("")
                        .to_string(),
                },
            )
        })
        .collect();
    let global_inits: IndexMap<&str, i64> = globals
        .iter()
        .map(|g| {
            let init = match g.init {
                Some(GlobalInit::Scalar(n)) => n,
                _ => 0,
            };
            (g.name.as_str(), init)
        })
        .collect();

    let mut init_stores: IndexMap<i64, Vec<i64>> = IndexMap::new();
    for g in &zp.globals {
        if g.storage != Storage::Zp {
            continue;
        }
        let init = global_inits.get(g.name.as_str()).copied().unwrap_or(0);
        let width = storage_bytes(global_types.get(g.name.as_str()).copied());
        init_stores
            .entry(low_byte(init))
            .or_default()
            .push(g.address);
        if width == 2 {
            init_stores
                .entry(high_byte(init))
                .or_default()
                .push(g.address + 1);
        }
    }
    let mut global_init_program: Vec<Directive> = Vec::new();
    for (value, addresses) in &init_stores {
        global_init_program.push(lda_imm(*value));
        for address in addresses {
            global_init_program.push(sta_zp(*address));
        }
    }

    let image = image_for(machine)?;

    let bss_origin = defsym.get("__bss_origin").copied();
    let bss_ceiling = defsym.get("__bss_ceiling").copied();
    let mut bss_cursor = bss_origin.unwrap_or(0);
    struct RamInit {
        label: String,
        address: i64,
        values: Vec<i64>,
    }
    let mut ram_inits: Vec<RamInit> = Vec::new();

    let mut data_array_globals: Vec<DataArrayGlobal> = Vec::new();
    let mut pinned_arrays: Vec<Directive> = Vec::new();
    let mut arrays: IndexMap<String, ArrayInfo> = IndexMap::new();
    for g in globals {
        let Some(array) = g.array else { continue };
        let width = storage_bytes(Some(&g.ty));
        if width != 1 && width != 2 {
            return refuse(format!(
                "'{}' is an array<{}, {}>: only a 1- or 2-byte element is lowered yet",
                g.name, g.ty, array
            ));
        }
        let mutable = g.constant != Some(true);
        if let Some(address) = g.address {
            pinned_arrays.push(Directive::Equate {
                name: array_label(&g.name),
                value: address,
                prov: None,
            });
            arrays.insert(
                g.name.clone(),
                ArrayInfo {
                    element_type: g.ty.clone(),
                    mutable: Some(mutable),
                    length: Some(array),
                },
            );
            continue;
        }
        let init: Vec<i64> = match &g.init {
            Some(GlobalInit::Array(values)) => values.clone(),
            None => vec![0; usize::try_from(array).unwrap_or(0)],
            Some(_) => {
                return refuse(format!(
                    "'{}' is an array<{}, {}> whose initializer is not a list of numbers",
                    g.name, g.ty, array
                ));
            }
        };
        if image.writable_image == Some(false) && mutable {
            let (Some(origin), Some(ceiling)) = (bss_origin, bss_ceiling) else {
                return refuse(format!(
                    "'{}' is a mutable array and the {machine_name}'s image is a ROM, so it needs real RAM — but the hardware sheet names no RAM window (defsym.__bss_origin/__bss_ceiling)",
                    g.name
                ));
            };
            let _ = origin;
            let size = width * array;
            if bss_cursor + size > ceiling {
                return refuse(format!(
                    "'{}' needs {} byte(s) of the {machine_name}'s RAM but only {} byte(s) remain (${}..${})",
                    g.name,
                    size,
                    (ceiling - bss_cursor).max(0),
                    hex_upper(bss_cursor, 0),
                    hex_upper(ceiling - 1, 0)
                ));
            }
            pinned_arrays.push(Directive::Equate {
                name: array_label(&g.name),
                value: bss_cursor,
                prov: None,
            });
            if init.iter().any(|v| *v != 0) {
                let mut values = Vec::new();
                for element in &init {
                    values.push(low_byte(*element));
                    if width == 2 {
                        values.push(high_byte(*element));
                    }
                }
                ram_inits.push(RamInit {
                    label: format!("__8bs_rominit_{}", g.name),
                    address: bss_cursor,
                    values,
                });
            }
            bss_cursor += size;
            arrays.insert(
                g.name.clone(),
                ArrayInfo {
                    element_type: g.ty.clone(),
                    mutable: Some(true),
                    length: Some(array),
                },
            );
            continue;
        }
        data_array_globals.push(DataArrayGlobal {
            name: g.name.clone(),
            type_name: g.ty.clone(),
            array,
            init,
        });
        arrays.insert(
            g.name.clone(),
            ArrayInfo {
                element_type: g.ty.clone(),
                mutable: Some(mutable),
                length: Some(array),
            },
        );
    }

    let ram_clear_program: Vec<Directive> = match bss_origin {
        Some(origin) => {
            let mut program = clear_ram(origin, bss_cursor);
            for (i, init) in ram_inits.iter().enumerate() {
                program.extend(copy_to_ram(
                    &init.label,
                    init.address,
                    init.values.len() as i64,
                    &format!("__8bs_ram_init_{i}"),
                ));
            }
            program
        }
        None => Vec::new(),
    };
    let mut ram_init_data: Vec<Directive> = Vec::new();
    for init in &ram_inits {
        ram_init_data.push(label_directive(&init.label));
        ram_init_data.push(Directive::Byte {
            values: init.values.clone(),
            prov: None,
        });
    }

    let mut param_cursor = zp_budget.zp_origin + zp.zp_used;
    let (mut wait_frame_acc, mut wait_frame_num) = (0, 0);
    if needs_wait_frame {
        match place_zp(
            param_cursor,
            WAIT_FRAME_ZP_BYTES,
            zp_budget.zp_ceiling,
            &zp_holes,
        ) {
            PlaceZp::Full { remaining, .. } => {
                return refuse(format!(
                    "waitFrame() needs {WAIT_FRAME_ZP_BYTES} bytes of zero page for its own pacing state but only {remaining} byte(s) remain"
                ));
            }
            PlaceZp::Placed { address, next } => {
                wait_frame_acc = address;
                wait_frame_num = address + 4;
                param_cursor = next;
            }
        }
    }

    let mut multiply: Option<MultiplyCells> = None;
    if uses_multiply(functions) {
        match place_zp(
            param_cursor,
            MULTIPLY_ZP_BYTES,
            zp_budget.zp_ceiling,
            &zp_holes,
        ) {
            PlaceZp::Full { remaining, .. } => {
                return refuse(format!(
                    "the '*' routine needs {MULTIPLY_ZP_BYTES} bytes of zero page for its operands but only {remaining} byte(s) remain"
                ));
            }
            PlaceZp::Placed { address, next } => {
                multiply = Some(multiply_cells(address));
                param_cursor = next;
            }
        }
    }

    // ---- zero-page frames: measure, lay out, then lower for real ----
    let frame_origin = param_cursor;
    let mut shapes: IndexMap<String, FrameShape> = IndexMap::new();
    let mut provisional_sites: IndexMap<String, FunctionSite> = IndexMap::new();
    for f in functions {
        let mut widths: Vec<i64> = Vec::new();
        for p in &f.params {
            if p.ty == "array" {
                return refuse(format!(
                    "'{}({})': array parameters aren't lowered yet",
                    f.name, p.name
                ));
            }
            let width = storage_bytes(Some(&p.ty));
            if width != 1 && width != 2 {
                return refuse(format!(
                    "'{}({})' is '{}' ({} bytes): only 8-bit and 16-bit parameters are lowered yet",
                    f.name, p.name, p.ty, width
                ));
            }
            widths.push(width);
        }
        let return_type = f.return_type.as_str();
        let return_bytes = if return_type == "void" {
            0
        } else {
            storage_bytes(Some(return_type))
        };
        if return_bytes > 2 {
            return refuse(format!(
                "'{}' returns '{}' ({} bytes): only an 8-bit, 16-bit, or void return is lowered yet",
                f.name, return_type, return_bytes
            ));
        }
        let mut cursor = frame_origin;
        let params: Vec<SiteParam> = widths
            .iter()
            .map(|&width| {
                let address = cursor;
                cursor += width;
                SiteParam { address, width }
            })
            .collect();
        let return_pair = (return_bytes == 2).then_some(cursor);
        shapes.insert(
            f.name.clone(),
            FrameShape {
                param_widths: widths,
                return_width: if return_bytes == 2 { 2 } else { 0 },
            },
        );
        provisional_sites.insert(
            f.name.clone(),
            FunctionSite {
                label: format!("__8bs_fn_{}", f.name),
                params,
                return_type: return_type.to_string(),
                return_pair,
            },
        );
    }

    let mut frame_needs: IndexMap<String, FrameNeed> = IndexMap::new();
    for f in functions {
        let Some(site) = provisional_sites.get(&f.name) else {
            continue;
        };
        let params: Vec<ParamBinding> = f
            .params
            .iter()
            .zip(&site.params)
            .map(|(p, s)| ParamBinding {
                name: p.name.clone(),
                ty: p.ty.clone(),
                address: s.address,
            })
            .collect();
        let scratch_base = frame_origin
            + site.params.iter().map(|p| p.width).sum::<i64>()
            + if site.return_pair.is_some() { 2 } else { 0 };
        let mut options = LowerOptions {
            globals: global_bindings.clone(),
            locals: LocalAllocator::new(scratch_base, 0x10000, &[]),
            params,
            functions: provisional_sites.clone(),
            arrays: arrays.clone(),
            multiply,
            return_pair: site.return_pair,
            fn_name: None,
            fn_file: None,
            origin_files: IndexMap::new(),
        };
        if let Err(error) = lower(&f.body, &mut options, &mut c) {
            return refuse(format!("in '{}': {error}", f.name));
        }
        frame_needs.insert(
            f.name.clone(),
            FrameNeed {
                bytes: scratch_base - frame_origin + options.locals.used(),
            },
        );
    }

    let layout = layout_frames(
        functions,
        &input.entry,
        &frame_needs,
        frame_origin,
        zp_budget.zp_ceiling,
        &zp_holes,
    )?;

    let mut function_sites: IndexMap<String, FunctionSite> = IndexMap::new();
    for f in functions {
        let (Some(shape), Some(start)) = (shapes.get(&f.name), layout.starts.get(&f.name)) else {
            continue;
        };
        let mut cursor = *start;
        let params: Vec<SiteParam> = shape
            .param_widths
            .iter()
            .map(|&width| {
                let address = cursor;
                cursor += width;
                SiteParam { address, width }
            })
            .collect();
        let return_pair = (shape.return_width == 2).then_some(cursor);
        function_sites.insert(
            f.name.clone(),
            FunctionSite {
                label: format!("__8bs_fn_{}", f.name),
                params,
                return_type: f.return_type.clone(),
                return_pair,
            },
        );
    }

    let mut lowered_functions: Vec<LoweredFunction> = Vec::new();
    for f in functions {
        let (Some(site), Some(shape), Some(start), Some(need)) = (
            function_sites.get(&f.name),
            shapes.get(&f.name),
            layout.starts.get(&f.name),
            frame_needs.get(&f.name),
        ) else {
            continue;
        };
        let params: Vec<ParamBinding> = f
            .params
            .iter()
            .zip(&site.params)
            .map(|(p, s)| ParamBinding {
                name: p.name.clone(),
                ty: p.ty.clone(),
                address: s.address,
            })
            .collect();
        let scratch_base = site.params.iter().fold(*start, |a, p| a + p.width) + shape.return_width;
        let mut options = LowerOptions {
            globals: global_bindings.clone(),
            locals: LocalAllocator::new(scratch_base, *start + need.bytes, &[]),
            params,
            functions: function_sites.clone(),
            arrays: arrays.clone(),
            multiply,
            return_pair: site.return_pair,
            fn_name: Some(f.name.clone()),
            fn_file: origin_files
                .get(&f.name)
                .cloned()
                .or_else(|| f.file.clone()),
            origin_files: origin_files.clone(),
        };
        let lowered = match lower(&f.body, &mut options, &mut c) {
            Ok(lowered) => lowered,
            Err(error) => return refuse(format!("in '{}': {error}", f.name)),
        };
        lowered_functions.push(LoweredFunction {
            name: f.name.clone(),
            label: site.label.clone(),
            program: lowered.program,
            parts: lowered.parts,
            is_entry: f.name == input.entry,
        });
    }
    let locals_cursor = layout.floor;

    let entry_program: Vec<Directive> = lowered_functions
        .iter()
        .find(|f| f.is_entry)
        .map(|f| f.program.clone())
        .unwrap_or_default();
    let every_instruction: Vec<Directive> = lowered_functions
        .iter()
        .flat_map(|f| f.program.iter().cloned())
        .collect();
    let mut used_strings: IndexSet<i64> = IndexSet::new();
    for f in functions {
        collect_string_indexes(&f.body, &mut used_strings);
    }
    let strings: Vec<IrString> = input
        .strings
        .iter()
        .map(|s| IrString {
            text: s.text.clone(),
            bytes: s.bytes.iter().map(|b| i64::from(*b)).collect(),
        })
        .collect();
    let data_section = build_data_section(&strings, &data_array_globals, Some(&used_strings));

    let frame_hook_name = input.frame_hook.name.as_deref();
    let frame_hook_label: Option<&str> = frame_hook_name.and_then(|name| {
        lowered_functions
            .iter()
            .find(|f| f.name == name && !f.is_entry)
            .map(|f| f.label.as_str())
    });
    if let Some(name) = frame_hook_name
        && frame_hook_label.is_none()
        && input.frame_hook.used
    {
        return refuse(format!(
            "the {machine_name}'s frame runtime calls {name}() after every hardware frame, but the linked program no longer has it as a callable function — it was inlined into its call sites and pruned. A void function the backend calls has to end with an explicit 'return;' to stay one (see packages/nes/src/index.8bs)"
        ));
    }
    let wait_frame_setup_program = if needs_wait_frame {
        wait_frame_setup(input.frame_rate, wait_frame_acc, wait_frame_num, machine)
    } else {
        Vec::new()
    };
    let wait_frame_routine_program = if needs_wait_frame {
        wait_frame_routine(wait_frame_acc, wait_frame_num, machine, frame_hook_label)
    } else {
        Vec::new()
    };
    let multiply_program = multiply.as_ref().map_or_else(Vec::new, multiply_routine);

    let (native_init, native_text, native_entries) = if machine == Machine::Nes {
        (Vec::new(), Vec::new(), Vec::new())
    } else {
        let sources = read_native(&input.native_sources, roots)?;
        let native = assemble_native(&sources, &referenced_labels(&every_instruction))?;
        let entries: Vec<SizeReportEntry> = native
            .entries
            .into_iter()
            .map(|e| SizeReportEntry {
                name: e.name,
                bytes: e.bytes,
            })
            .collect();
        (native.init_program, native.text_program, entries)
    };
    let sensitive: Vec<Directive> = every_instruction
        .iter()
        .chain(&wait_frame_setup_program)
        .chain(&wait_frame_routine_program)
        .chain(&multiply_program)
        .chain(&native_init)
        .chain(&native_text)
        .cloned()
        .collect();
    let needs_cld = uses_decimal_sensitive_math(&sensitive);

    let own_machine_program: Vec<Directive> =
        if needs_wait_frame && !wait_frame_keeps_interrupts(machine) {
            vec![instruction("SEI", AddressingMode::Implied, None)]
        } else {
            Vec::new()
        };

    let returns_to_basic = !image.entry_is_vectored && image.ends_by_halting != Some(true);
    let borrowed_zp =
        if BORROWS_ZERO_PAGE.contains(&machine) && !needs_wait_frame && returns_to_basic {
            locals_cursor - zp_budget.zp_origin
        } else {
            0
        };
    let zp_borrow_program = borrow_zero_page(zp_budget.zp_origin, borrowed_zp);
    let zp_return_program = return_zero_page(zp_budget.zp_origin, borrowed_zp);

    let iso_mode_program: Vec<Directive> = if machine == Machine::Cx16 {
        vec![
            instruction(
                "LDA",
                AddressingMode::Immediate,
                Some(Operand::Value { value: 0x0f }),
            ),
            instruction(
                "JSR",
                AddressingMode::Absolute,
                Some(Operand::Value { value: 0xffd2 }),
            ),
        ]
    } else {
        Vec::new()
    };

    let halt_label = "__8bs_halt";
    let halt_edge = if image.entry_is_vectored && frame_hook_label.is_some() {
        frame_edge_wait(machine, halt_label)
    } else {
        None
    };
    let end_program: Vec<Directive> =
        if image.entry_is_vectored || image.ends_by_halting == Some(true) {
            let mut program = vec![label_directive(halt_label)];
            if let Some(edge) = &halt_edge {
                program.extend(edge.iter().cloned());
            }
            if let (Some(_), Some(hook)) = (&halt_edge, frame_hook_label) {
                program.push(instruction(
                    "JSR",
                    AddressingMode::Absolute,
                    Some(Operand::Label {
                        name: hook.to_string(),
                        byte: None,
                        offset: None,
                    }),
                ));
            }
            program.push(instruction(
                "JMP",
                AddressingMode::Absolute,
                Some(Operand::Label {
                    name: halt_label.to_string(),
                    byte: None,
                    offset: None,
                }),
            ));
            program
        } else {
            let mut program = zp_return_program;
            program.extend(epilogue());
            program
        };

    let machine_startup_program: Vec<Directive> = if machine == Machine::Nes {
        nes_reset_init()
    } else {
        Vec::new()
    };

    let mut combined: Vec<Directive> = Vec::new();
    combined.extend(machine_startup_program.iter().cloned());
    combined.extend(prologue(needs_cld));
    combined.extend(iso_mode_program.iter().cloned());
    combined.extend(own_machine_program.iter().cloned());
    combined.extend(ram_clear_program.iter().cloned());
    combined.extend(zp_borrow_program.iter().cloned());
    combined.extend(global_init_program.iter().cloned());
    combined.extend(wait_frame_setup_program.iter().cloned());
    combined.extend(native_init);
    combined.extend(entry_program);
    combined.extend(end_program.iter().cloned());
    for f in lowered_functions.iter().filter(|f| !f.is_entry) {
        combined.push(label_directive(&f.label));
        combined.extend(f.program.iter().cloned());
        combined.push(rts());
    }
    combined.extend(wait_frame_routine_program.iter().cloned());
    combined.extend(multiply_program.iter().cloned());
    combined.extend(native_text);
    combined.extend(pinned_arrays);
    combined.extend(ram_init_data);
    combined.extend(zero_page_save_data(borrowed_zp));
    combined.extend(data_section.iter().cloned());

    let prelude = image.prelude(load_address)?;

    let ram_ceiling_bytes = defsym.get("__ram_ceiling").copied();
    let ram_size_kib = defsym.get("__ram_size").copied();
    let ram_ceiling = match (ram_ceiling_bytes, ram_size_kib) {
        (Some(bytes), _) => bytes,
        (None, Some(kib)) => kib * 1024,
        (None, None) => {
            return refuse(format!(
                "the {machine_name} hardware sheet is missing defsym.__ram_ceiling (or defsym.__ram_size), the RAM ceiling the linker needs"
            ));
        }
    };

    let linked = link(
        &LinkInput {
            code_origin: prelude.code_start,
            ram_ceiling,
            code: SectionContent::Assembly(combined),
            data: None,
            bss: None,
            zp_origin: Some(zp_budget.zp_origin),
            zp: Some(locals_cursor - zp_budget.zp_origin),
            zp_ceiling: Some(zp_budget.zp_ceiling),
            pinned: None,
        },
        &mut c,
    )?;

    let mut body = prelude.bytes.clone();
    body.extend_from_slice(&linked.bytes);
    if machine == Machine::Nes {
        // image-nes.ts checks the load address and the end of the program before it reads any
        // native source, so those refusals come first.
        if let Err(message) =
            crate::image::nes::check_fit(load_address, body.len(), prelude.code_start)
        {
            return Err(BuildError {
                message,
                link: Some(Box::new(linked)),
            });
        }
    }
    let extras = ImageExtras {
        native_sources: if machine == Machine::Nes {
            match read_native(&input.native_sources, roots) {
                Ok(sources) => sources,
                Err(mut error) => {
                    error.link = Some(Box::new(linked));
                    return Err(error);
                }
            }
        } else {
            Vec::new()
        },
        chr_patches: Some(
            input
                .chr_patches
                .iter()
                .map(|p| ChrPatch {
                    tile: p.tile,
                    bytes: p.bytes.iter().map(|b| i64::from(*b)).collect(),
                })
                .collect(),
        ),
    };
    let bytes = match image.file(load_address, &body, prelude.code_start, &extras) {
        Ok(bytes) => bytes,
        Err(message) => {
            return Err(BuildError {
                message,
                link: Some(Box::new(linked)),
            });
        }
    };

    let size_report = if input.report {
        let mut entries: Vec<SizeReportEntry> = Vec::new();
        for f in &lowered_functions {
            let parts: Vec<SizePart<'_>> = f
                .parts
                .iter()
                .map(|p| SizePart {
                    origin: p.origin.as_deref(),
                    program: &p.program,
                })
                .collect();
            entries.extend(function_size_entries(&f.name, &parts, f.is_entry));
        }
        let entry = |name: &str, bytes: i64| SizeReportEntry {
            name: name.to_string(),
            bytes,
        };
        entries.push(entry(
            "(wait-frame setup)",
            directive_bytes(&wait_frame_setup_program),
        ));
        entries.push(entry(
            "(wait-frame routine)",
            directive_bytes(&wait_frame_routine_program),
        ));
        entries.push(entry(
            "(multiply routine)",
            directive_bytes(&multiply_program),
        ));
        entries.push(entry(
            "(global initializers)",
            directive_bytes(&global_init_program),
        ));
        entries.push(entry(
            "(string/const-array data)",
            directive_bytes(&data_section),
        ));
        entries.push(entry(
            "(image header + prologue/epilogue)",
            (bytes.len() as i64 - linked.bytes.len() as i64)
                + directive_bytes(&prologue(needs_cld))
                + directive_bytes(&iso_mode_program)
                + directive_bytes(&machine_startup_program)
                + directive_bytes(&own_machine_program)
                + directive_bytes(&ram_clear_program)
                + directive_bytes(&zp_borrow_program)
                + directive_bytes(&end_program)
                + directive_bytes(&zero_page_save_data(borrowed_zp)),
        ));
        entries.extend(native_entries);
        entries.retain(|e| e.bytes > 0);
        entries.sort_by_key(|e| std::cmp::Reverse(e.bytes));
        Some(entries)
    } else {
        None
    };

    Ok(BuildOutput {
        link: linked,
        bytes,
        size_report,
    })
}
