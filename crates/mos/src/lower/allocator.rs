//! Port of mos/lower/allocator.ts: a bump allocator over one contiguous
//! zero-page range, with LIFO release. `ZpBudgetError` is `Err(String)`.

use crate::zp::{PlaceZp, ZpHole, place_zp};
use jsnum::hex_upper;

fn hex(value: i64) -> String {
    format!("${}", hex_upper(value, 4))
}

#[derive(Clone, Debug)]
pub struct LocalAllocator {
    origin: i64,
    ceiling: i64,
    holes: Vec<ZpHole>,
    next: i64,
    high: i64,
}

impl LocalAllocator {
    #[must_use]
    pub fn new(origin: i64, ceiling: i64, holes: &[ZpHole]) -> Self {
        Self {
            origin,
            ceiling,
            holes: holes.to_vec(),
            next: origin,
            high: origin,
        }
    }

    /// A point in time to release back to later.
    #[must_use]
    pub fn mark(&self) -> i64 {
        self.next
    }

    /// Frees everything allocated since `mark`.
    pub fn release(&mut self, mark: i64) {
        self.next = mark;
    }

    /// One byte.
    ///
    /// # Errors
    /// The `ZpBudgetError` text when the budget is exhausted.
    pub fn alloc(&mut self, what: &str) -> Result<i64, String> {
        self.alloc_bytes(1, what)
    }

    /// Two adjacent bytes (little-endian) for a 16-bit value.
    ///
    /// # Errors
    /// The `ZpBudgetError` text when fewer than 2 bytes remain.
    pub fn alloc16(&mut self, what: &str) -> Result<i64, String> {
        self.alloc_bytes(2, what)
    }

    /// `allocBytes`: `size` is 1 or 2.
    ///
    /// # Errors
    /// The `ZpBudgetError` text when the budget is exhausted.
    pub fn alloc_bytes(&mut self, size: i64, what: &str) -> Result<i64, String> {
        match place_zp(self.next, size, self.ceiling, &self.holes) {
            PlaceZp::Full { remaining, cursor } => Err(format!(
                "{what} needs {size} byte{} of zero page but only {remaining} byte(s) remain ({}..{})",
                if size == 1 { "" } else { "(s)" },
                hex(cursor),
                hex(self.ceiling - 1)
            )),
            PlaceZp::Placed { address, next } => {
                self.next = next;
                self.high = self.high.max(self.next);
                Ok(address)
            }
        }
    }

    /// The most zero page ever live at once (`get used`).
    #[must_use]
    pub fn used(&self) -> i64 {
        self.high - self.origin
    }
}
