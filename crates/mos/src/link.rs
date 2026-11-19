//! Port of mos/link/index.ts
//!
//! The linker: placement policy over already-encoded content. Code, then data, then bss,
//! one after another with no gaps; `zp` lives in its own address range.

use crate::asm::assemble::{Directive, ListingLine};
use crate::asm::relax::assemble_relaxed;
use crate::build::Counters;
use indexmap::IndexMap;
use jsnum::hex_upper;
use serde::{Deserialize, Serialize};

/// Content of a section (`link/index.ts:19`). In JSON: `{kind: "bytes", bytes}` or
/// `{kind: "assembly", program}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "SectionRepr", into = "SectionRepr")]
pub enum SectionContent {
    Bytes(Vec<u8>),
    Assembly(Vec<Directive>),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum SectionRepr {
    Bytes { bytes: Vec<u8> },
    Assembly { program: Vec<Directive> },
}

impl From<SectionRepr> for SectionContent {
    fn from(repr: SectionRepr) -> Self {
        match repr {
            SectionRepr::Bytes { bytes } => Self::Bytes(bytes),
            SectionRepr::Assembly { program } => Self::Assembly(program),
        }
    }
}

impl From<SectionContent> for SectionRepr {
    fn from(content: SectionContent) -> Self {
        match content {
            SectionContent::Bytes(bytes) => Self::Bytes { bytes },
            SectionContent::Assembly(program) => Self::Assembly { program },
        }
    }
}

/// An address fixed by hardware or convention, outside every section (`link/index.ts:26`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PinnedSymbol {
    pub name: String,
    pub address: i64,
}

/// `link/index.ts:31`. Each `?` field is an `Option`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkInput {
    /// Where the code section starts.
    pub code_origin: i64,
    /// The absolute top of RAM, exclusive.
    pub ram_ceiling: i64,
    pub code: SectionContent,
    /// Placed right after code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<SectionContent>,
    /// Reserved, uninitialized bytes right after data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bss: Option<i64>,
    /// Where the zp section starts (default 2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zp_origin: Option<i64>,
    /// Reserved zero-page bytes, placed at `zp_origin`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zp: Option<i64>,
    /// The zero-page ceiling (default 0x100).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zp_ceiling: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<Vec<PinnedSymbol>>,
}

/// `link/index.ts:52`. `name` is one of `code`, `data`, `bss`, `zp`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SectionLayout {
    pub name: &'static str,
    pub origin: i64,
    pub size: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Memory {
    pub variables: i64,
    pub program: i64,
}

/// A successful link (`LinkResult` with `ok: true`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Linked {
    pub bytes: Vec<u8>,
    pub symbols: IndexMap<String, i64>,
    pub layout: Vec<SectionLayout>,
    pub memory: Memory,
    pub listing: Vec<ListingLine>,
}

fn hex(value: i64) -> String {
    hex_upper(value, 4)
}

struct Placed {
    bytes: Vec<u8>,
    symbols: IndexMap<String, i64>,
    listing: Vec<ListingLine>,
}

/// Assembles `content` at `origin`, or hands back already-final bytes (`link/index.ts:74`).
fn place(
    content: &SectionContent,
    origin: i64,
    section: &str,
    c: &mut Counters,
) -> Result<Placed, String> {
    let program = match content {
        SectionContent::Bytes(bytes) => {
            return Ok(Placed {
                bytes: bytes.clone(),
                symbols: IndexMap::new(),
                listing: Vec::new(),
            });
        }
        SectionContent::Assembly(program) => program,
    };
    let result = assemble_relaxed(program, origin, c).map_err(|e| format!("{section}: {e}"))?;
    Ok(Placed {
        bytes: result.bytes,
        symbols: result.labels,
        listing: result.listing,
    })
}

/// Places code, data, bss and zp; checks every ceiling; merges every symbol (`link/index.ts:94`).
///
/// # Errors
/// The first placement problem, with the JS text.
pub fn link(input: &LinkInput, c: &mut Counters) -> Result<Linked, String> {
    let code = place(&input.code, input.code_origin, "code", c)?;
    let code_len = code.bytes.len() as i64;
    let code_end = input.code_origin + code_len;

    let data_origin = code_end;
    let empty = SectionContent::Bytes(Vec::new());
    let data = place(
        input.data.as_ref().unwrap_or(&empty),
        data_origin,
        "data",
        c,
    )?;
    let data_len = data.bytes.len() as i64;
    let data_end = data_origin + data_len;

    let bss_origin = data_end;
    let bss_size = input.bss.unwrap_or(0);
    let bss_end = bss_origin + bss_size;

    let over = if code_end > input.ram_ceiling {
        Some(("code", code_end))
    } else if data_end > input.ram_ceiling {
        Some(("data", data_end))
    } else if bss_end > input.ram_ceiling {
        Some(("bss", bss_end))
    } else {
        None
    };
    if let Some((section, end)) = over {
        return Err(format!(
            "{section}: program ends at ${}, {} byte(s) past the ${} RAM ceiling",
            hex(end),
            end - input.ram_ceiling,
            hex(input.ram_ceiling)
        ));
    }

    let zp_origin = input.zp_origin.unwrap_or(0x02);
    let zp_size = input.zp.unwrap_or(0);
    let zp_ceiling = input.zp_ceiling.unwrap_or(0x100);
    let zp_end = zp_origin + zp_size;
    if zp_end > zp_ceiling {
        return Err(format!(
            "zp: reserves up to ${}, {} byte(s) past the ${} zero-page ceiling",
            hex(zp_end),
            zp_end - zp_ceiling,
            hex(zp_ceiling)
        ));
    }

    let layout = vec![
        SectionLayout {
            name: "code",
            origin: input.code_origin,
            size: code_len,
        },
        SectionLayout {
            name: "data",
            origin: data_origin,
            size: data_len,
        },
        SectionLayout {
            name: "bss",
            origin: bss_origin,
            size: bss_size,
        },
        SectionLayout {
            name: "zp",
            origin: zp_origin,
            size: zp_size,
        },
    ];

    let mut symbols: IndexMap<String, i64> = IndexMap::new();
    for (name, address) in code.symbols {
        symbols.insert(name, address);
    }
    for (name, address) in data.symbols {
        if symbols.contains_key(&name) {
            return Err(format!("data: label '{name}' is already defined in code"));
        }
        symbols.insert(name, address);
    }

    for pinned in input.pinned.as_deref().unwrap_or(&[]) {
        let address = pinned.address;
        let placed = layout
            .iter()
            .find(|s| s.size > 0 && address >= s.origin && address < s.origin + s.size);
        if let Some(placed) = placed {
            return Err(format!(
                "pinned symbol '{}' at ${} falls inside the {} section (${}-${})",
                pinned.name,
                hex(address),
                placed.name,
                hex(placed.origin),
                hex(placed.origin + placed.size - 1)
            ));
        }
        if symbols.contains_key(&pinned.name) {
            return Err(format!(
                "pinned symbol '{}' collides with a label of the same name",
                pinned.name
            ));
        }
        symbols.insert(pinned.name.clone(), address);
    }

    let mut bytes = code.bytes;
    bytes.extend(data.bytes);
    let program = bytes.len() as i64;

    // Code first, then data, the same order their bytes land in.
    let mut listing = code.listing;
    listing.extend(data.listing);

    Ok(Linked {
        bytes,
        symbols,
        layout,
        memory: Memory {
            variables: bss_size + zp_size,
            program,
        },
        listing,
    })
}
