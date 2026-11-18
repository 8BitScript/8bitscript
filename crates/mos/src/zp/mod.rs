//! Port of mos/zp/index.ts and mos/zp/frames.ts

use crate::types::storage_bytes;
use jsnum::{Nullable, hex_upper};
use serde::{Deserialize, Serialize};

pub mod frames;

/// A global's own initial value: a plain number, or a const array's elements.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Init {
    Number(i64),
    Array(Vec<i64>),
}

/// The parts of a real IR global this allocator reads (`zp/index.ts:27-34`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct IrGlobal {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub address: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub array: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constant: Option<bool>,
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub init: Nullable<Init>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZpHole {
    /// Inclusive.
    pub start: i64,
    /// Exclusive.
    pub end: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub zp_origin: i64,
    /// Exclusive: the first address no longer in budget.
    pub zp_ceiling: i64,
    /// Ranges this allocator must not occupy; absent means none.
    #[serde(default)]
    pub holes: Vec<ZpHole>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaceZp {
    Placed { address: i64, next: i64 },
    Full { remaining: i64, cursor: i64 },
}

/// Next free address of `size` bytes that does not overlap any hole. Skips a
/// hole entirely rather than straddling it.
#[must_use]
pub fn place_zp(cursor: i64, size: i64, ceiling: i64, holes: &[ZpHole]) -> PlaceZp {
    let mut addr = cursor;
    loop {
        if let Some(hole) = holes.iter().find(|h| addr < h.end && addr + size > h.start) {
            addr = hole.end;
            continue;
        }
        if addr + size > ceiling {
            return PlaceZp::Full {
                remaining: (ceiling - addr).max(0),
                cursor: addr,
            };
        }
        return PlaceZp::Placed {
            address: addr,
            next: addr + size,
        };
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Storage {
    Zp,
    Pinned,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AllocatedGlobal {
    pub name: String,
    pub address: i64,
    pub storage: Storage,
    pub size: i64,
}

/// The `ok: true` result of `allocate`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Allocation {
    pub globals: Vec<AllocatedGlobal>,
    pub zp_used: i64,
}

/// Assigns every non-pinned scalar global a zero-page address; refuses
/// strings, unknown types and zp overflow, naming the global each time.
///
/// # Errors
/// The JS `error` text, byte for byte.
pub fn allocate(globals: &[IrGlobal], budget: &Budget) -> Result<Allocation, String> {
    let mut allocated = Vec::new();
    let mut zp_next = budget.zp_origin;

    for global in globals {
        if let Some(address) = global.address {
            allocated.push(AllocatedGlobal {
                name: global.name.clone(),
                address,
                storage: Storage::Pinned,
                size: 0,
            });
            continue;
        }

        if global.array.is_some() {
            continue;
        }
        if global.ty == "string" {
            return Err(format!(
                "global '{}': a bare string global isn't allocated yet",
                global.name
            ));
        }

        let size = storage_bytes(Some(&global.ty));
        if size == 0 {
            return Err(format!(
                "global '{}': unknown type '{}', can't size it",
                global.name, global.ty
            ));
        }

        match place_zp(zp_next, size, budget.zp_ceiling, &budget.holes) {
            PlaceZp::Full { remaining, cursor } => {
                return Err(format!(
                    "global '{}' needs {} byte(s) of zero page but only {} byte(s) remain (${}..${})",
                    global.name,
                    size,
                    remaining,
                    hex_upper(cursor, 4),
                    hex_upper(budget.zp_ceiling - 1, 4)
                ));
            }
            PlaceZp::Placed { address, next } => {
                allocated.push(AllocatedGlobal {
                    name: global.name.clone(),
                    address,
                    storage: Storage::Zp,
                    size,
                });
                zp_next = next;
            }
        }
    }

    Ok(Allocation {
        globals: allocated,
        zp_used: zp_next - budget.zp_origin,
    })
}
