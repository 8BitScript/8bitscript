//! Syntax-neutral front-end types (port spec P3-01): the AST, tokens, spans,
//! node identity, source kinds and the walker. The AST serializes to exactly
//! the JS `ast` dump shape (rulebook R6.2); the new syntax lowers to the same nodes
//! and adds no node kind (R6.4).

mod kind;
mod node;
mod normalize;
mod span;
mod token;
mod walk;

pub use kind::{SOURCE_EXTENSIONS, SourceKind};
pub use node::{Node, NodeId, NodeKind};
pub use normalize::{Difference, differences, normalize};
pub use span::{Span, utf16_len};
pub use token::{PartKind, TemplatePart, Token, TokenKind};
pub use walk::{children, children_mut, number_nodes, walk};
