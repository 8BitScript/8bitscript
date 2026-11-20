//! Port of packages/compiler/src/checker/immutable.mjs:1-49
//!
//! E20: assigning to a `let` that is not `let mut` (8BS1031).
//!
//! The new syntax's parser marks a plain `let` with `immutable: true`; the old parser never sets
//! it, so on an old-syntax tree this rule finds nothing.
//!
//! Names resolve by block scope; see `scopes`, the walk this shares with `8bs migrate` (a
//! binding the converter leaves plain must never be stored to in this checker's eyes).

use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use syntax::{Node, NodeKind, walk};

use super::scopes::{store_target, walk_scopes};

/// Whether a `for` is a range `for` (`for i in a..b`), whose update is the loop's own `i++`. The
/// parser builds it as a `ForStatement` with an immutable `let i` and that update, but its init
/// has no `let` keyword, so the init starts at the variable itself; a C-style
/// `for (let i ...; ...; ...)` starts at `let`. Only the range form steps its immutable
/// variable: in the C form a plain `let` that is updated is E20, and `i = 3;` in a range body
/// still is.
fn is_range_step(for_statement: &Node) -> bool {
    let NodeKind::ForStatement { init, update, .. } = &for_statement.kind else {
        return false;
    };
    let Some(init) = init.as_deref() else {
        return false;
    };
    let NodeKind::VariableDeclaration {
        name: Some(name),
        immutable,
        ..
    } = &init.kind
    else {
        return false;
    };
    if *immutable != Some(true) || init.start != name.start {
        return false;
    }
    let Some(Node {
        kind: NodeKind::UpdateExpression {
            operator, argument, ..
        },
        ..
    }) = update.as_deref()
    else {
        return false;
    };
    let (NodeKind::Identifier { name: stepped, .. }, NodeKind::Identifier { name: declared, .. }) =
        (&argument.kind, &name.kind)
    else {
        return false;
    };
    operator == "++" && stepped == declared
}

/// `checkImmutableLets(ast, file)`.
#[must_use]
pub fn check_immutable_lets(ast: &Node, file: &str) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    walk_scopes(
        ast,
        &mut |scopes, scope, root| {
            walk(root, &mut |n, _parent| {
                let Some(target) = store_target(n) else {
                    return;
                };
                let Some(hit) = scopes.target_of(scope, target) else {
                    return;
                };
                let immutable = matches!(
                    &hit.decl.kind,
                    NodeKind::VariableDeclaration {
                        immutable: Some(true),
                        ..
                    }
                );
                if !immutable {
                    return;
                }
                let NodeKind::Identifier { name, .. } = &hit.name.kind else {
                    return;
                };
                diagnostics.push(diagnostic(
                    codes::ASSIGN_TO_CONST,
                    format!("'{name}' is declared with let, not let mut, and cannot be assigned"),
                    file,
                    hit.name.start,
                    hit.name.length,
                    Severity::Error,
                ));
            });
        },
        Some(&is_range_step),
    );
    diagnostics
}
