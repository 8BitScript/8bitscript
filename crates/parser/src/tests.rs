//! Test declarations (test spec 3.1, 3.2). The parser reads `#[test]` like
//! any attribute; `convert` then turns the valid ones into `TestDecl` nodes
//! and reports the rest, and `strip_tests` takes them out of a program that
//! is going to be built.

use diagnostics::{Diagnostic, Severity, codes, diagnostic};
use syntax::{Node, NodeKind, children};

const M1: &str = "'#[test]' goes on a top-level 'fn' or a 'fn' inside '#[cfg(test)] mod'";
const M2: &str = "a test function takes no parameters and returns nothing";
const M3: &str = "'#[cfg(test)]' goes on a top-level 'mod'";
const M4: &str = "'#[test]' takes one string: the test's name";
const M5: &str = "a test function is not 'pub'";
const M6: &str = "a test function takes no other attributes";

pub(crate) fn is_test(decorator: &Node) -> bool {
    matches!(&decorator.kind, NodeKind::Decorator { name, .. } if name == "test")
}

pub(crate) fn is_cfg_test(decorator: &Node) -> bool {
    match &decorator.kind {
        NodeKind::Decorator { name, args } if name == "cfg" && args.len() == 1 => {
            args.first().is_some_and(
                |a| matches!(&a.kind, NodeKind::Identifier { name, .. } if name == "test"),
            )
        }
        _ => false,
    }
}

fn decorators_of(node: &Node) -> &[Node] {
    node.decorators.as_deref().unwrap_or(&[])
}

fn report(diagnostics: &mut Vec<Diagnostic>, file: &str, message: &str, at: &Node) {
    diagnostics.push(diagnostic(
        codes::SYNTAX_ERROR,
        message,
        file,
        at.start,
        at.length,
        Severity::Error,
    ));
}

/// The nodes under `node` that carry a `test` or `cfg(test)` attribute no
/// rule above accepted: M1 for `test`, M3 for `cfg(test)`.
fn check_children(node: &Node, file: &str, diagnostics: &mut Vec<Diagnostic>) {
    for child in children(node) {
        check_node(child, file, diagnostics);
        check_children(child, file, diagnostics);
    }
}

fn check_node(node: &Node, file: &str, diagnostics: &mut Vec<Diagnostic>) {
    for decorator in decorators_of(node) {
        if is_test(decorator) {
            report(diagnostics, file, M1, decorator);
        } else if is_cfg_test(decorator) {
            report(diagnostics, file, M3, decorator);
        }
    }
}

/// The `TestDecl` a function becomes, `Ok(None)` when it has no name or no
/// body (a parse error already said so), or the first failing check.
fn convert_function(node: &Node) -> Result<Option<Node>, (&'static str, &Node)> {
    let NodeKind::FunctionDeclaration {
        name: Some(name),
        params,
        return_type,
        body: Some(body),
        exported,
        ..
    } = &node.kind
    else {
        return Ok(None);
    };
    let NodeKind::Identifier { name: fn_name, .. } = &name.kind else {
        return Ok(None);
    };
    let decorators = decorators_of(node);
    let Some(decorator) = decorators.iter().find(|d| is_test(d)) else {
        return Ok(None);
    };
    if decorators.len() != 1 {
        return Err((M6, decorator));
    }
    let NodeKind::Decorator { args, .. } = &decorator.kind else {
        return Ok(None);
    };
    let test_name = match args.as_slice() {
        [] => fn_name.replace('_', " "),
        [one] => match &one.kind {
            NodeKind::StringLiteral { value, .. } => value.clone(),
            _ => return Err((M4, decorator)),
        },
        _ => return Err((M4, decorator)),
    };
    if !params.is_empty() || return_type.is_some() {
        return Err((M2, decorator));
    }
    if *exported {
        return Err((M5, decorator));
    }
    let end = body.start.saturating_add(body.length);
    Ok(Some(Node::new(
        decorator.start,
        end,
        NodeKind::TestDecl {
            name: test_name,
            body: body.clone(),
        },
    )))
}

/// A function that carries a `test` attribute, as a `TestDecl` when it is
/// valid. A failed check reports and leaves the node as it is.
fn convert_test_function(node: &mut Node, file: &str, diagnostics: &mut Vec<Diagnostic>) {
    let is_fn = matches!(node.kind, NodeKind::FunctionDeclaration { .. });
    if !is_fn || !decorators_of(node).iter().any(is_test) {
        check_node(node, file, diagnostics);
        check_children(node, file, diagnostics);
        return;
    }
    match convert_function(node) {
        Ok(Some(test)) => {
            check_children(node, file, diagnostics);
            *node = test;
        }
        Ok(None) => check_children(node, file, diagnostics),
        Err((message, at)) => {
            report(diagnostics, file, message, at);
            check_children(node, file, diagnostics);
        }
    }
}

/// Turn the valid test functions of a program into `TestDecl` nodes and
/// report every misplaced or malformed `#[test]` and `#[cfg(test)]`. Only
/// `Program.body` and the members of a `#[cfg(test)] mod` are looked at for
/// tests; every other node is checked for stray attributes.
pub fn convert(body: &mut [Node], file: &str, diagnostics: &mut Vec<Diagnostic>) {
    for node in body.iter_mut() {
        if matches!(node.kind, NodeKind::NamespaceDeclaration { .. })
            && decorators_of(node).iter().any(is_cfg_test)
        {
            for decorator in decorators_of(node) {
                if is_test(decorator) {
                    report(diagnostics, file, M1, decorator);
                }
            }
            if let NodeKind::NamespaceDeclaration { members, .. } = &mut node.kind {
                for member in members.iter_mut().flatten() {
                    convert_test_function(member, file, diagnostics);
                }
            }
        } else {
            convert_test_function(node, file, diagnostics);
        }
    }
}

/// Remove every `TestDecl` and every `#[cfg(test)]` `mod` from a program, so
/// a build never sees them. Node ids are not renumbered.
pub fn strip_tests(program: &mut Node) {
    if let NodeKind::Program { body } = &mut program.kind {
        body.retain(|node| {
            let test_mod = matches!(node.kind, NodeKind::NamespaceDeclaration { .. })
                && decorators_of(node).iter().any(is_cfg_test);
            !(test_mod || matches!(node.kind, NodeKind::TestDecl { .. }))
        });
    }
}
