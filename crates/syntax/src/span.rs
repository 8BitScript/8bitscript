//! Spans are UTF-16 code-unit offsets into the source text (rulebook R6.1).
//! A byte offset must never be stored in a `Token` or `Node`.

/// A `start`/`length` pair in UTF-16 code units, as every JS node and
/// diagnostic carries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Span {
    pub start: u32,
    pub length: u32,
}

impl Span {
    #[must_use]
    pub fn new(start: u32, length: u32) -> Self {
        Self { start, length }
    }

    /// `JS node(type, start, end, ...)`: the length is `end - start`
    /// (saturating, so a reversed pair cannot panic).
    #[must_use]
    pub fn from_range(start: u32, end: u32) -> Self {
        Self {
            start,
            length: end.saturating_sub(start),
        }
    }

    #[must_use]
    pub fn end(self) -> u32 {
        self.start.saturating_add(self.length)
    }
}

/// The length of `text` in UTF-16 code units (JS `text.length`), saturating
/// at `u32::MAX`.
#[must_use]
pub fn utf16_len(text: &str) -> u32 {
    u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX)
}
