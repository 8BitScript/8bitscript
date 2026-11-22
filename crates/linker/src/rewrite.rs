//! The one pass of the linker's rewrite half (`linker/index.mjs:683-1245`) that the scope, const
//! and import passes call. A later unit replaces this stub (R0.5).

use diagnostics::Diagnostic;
use mos_ir::Expr;

use crate::scope::Scope;
use crate::{ModuleSide, Unported};
use front::graph::LoadedGraph;

/// `rewriteExpression(expr, scope, module, diagnostics)`: not ported yet.
///
/// # Errors
/// Always [`Unported`]; callers pass it on.
pub fn rewrite_expression(
    _expr: &mut Expr,
    _scope: &Scope,
    _module: usize,
    _sides: &mut [ModuleSide],
    _graph: &LoadedGraph,
    _diagnostics: &mut Vec<Diagnostic>,
) -> Result<(), Unported> {
    Err(Unported)
}
