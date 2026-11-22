//! The scope lookups against the JS oracle (`gen/linker-scope.mjs` writes the golden files).

mod common;

use common::{TREES, assert_rows, prepare, scope_rows};
use linker::scope::{Scope, bind_local, child_scope};

#[test]
fn lookups_match() {
    for tree in TREES {
        let (l, _) = prepare(tree);
        assert_rows(
            &l,
            &scope_rows(&l),
            &["globalNamed", "isImportedName", "isStringName"],
        );
    }
}

#[test]
fn a_child_scope_is_a_copy() {
    let mut parent = Scope::new(
        [("a".to_string(), "a_out".to_string())]
            .into_iter()
            .collect(),
    );
    assert_eq!(parent.bound, None);
    let mut child = child_scope(&parent);
    assert_eq!(child.bound.as_ref().map(|b| b.len()), Some(0));
    bind_local(&mut child, "a");
    assert_eq!(child.names["a"], "a");
    assert!(child.is_bound("a"));
    // The parent is untouched by what the child binds.
    assert_eq!(parent.names["a"], "a_out");
    assert!(!parent.is_bound("a"));
    bind_local(&mut parent, "b");
    assert!(parent.is_bound("b") && parent.has("b"));
}
