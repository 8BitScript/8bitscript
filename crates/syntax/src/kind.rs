//! Source kinds (`source/index.mjs:10`, syntax spec 4.2).

/// The extension list in search order (`source/index.mjs:10`).
pub const SOURCE_EXTENSIONS: [&str; 4] = [".8bs", ".8bx", ".8bg", ".8ba"];

/// What a source path is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SourceKind {
    Bs,
    Bx,
    Bg,
    Ba,
}

impl SourceKind {
    /// Every kind, in `SOURCE_EXTENSIONS` order.
    pub const ALL: [SourceKind; 4] = [Self::Bs, Self::Bx, Self::Bg, Self::Ba];

    /// The extension with its dot, as the JS `sourceKind` string.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bs => ".8bs",
            Self::Bx => ".8bx",
            Self::Bg => ".8bg",
            Self::Ba => ".8ba",
        }
    }

    /// The kind for an exact extension string such as `".8bs"`.
    #[must_use]
    pub fn from_extension(ext: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == ext)
    }
}
