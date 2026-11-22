//! The import passes against the JS oracle (`gen/linker-scope.mjs` writes the golden files).

mod common;

use common::{
    TREES, assert_rows, bind_json, imports_json, namespace_rows, natives_json, prepare, rename_json,
};
use linker::ModuleSide;
use linker::imports::{Table, assign_output_names, resolve_namespace_member};

#[test]
fn the_graph_matches() {
    for tree in TREES {
        let l = common::load(tree);
        assert_eq!(
            l.text(natives_json(&l)),
            l.golden("natives.json"),
            "{tree}: natives"
        );
        assert_eq!(
            l.text(imports_json(&l)),
            l.golden("imports.json"),
            "{tree}: imports"
        );
    }
}

#[test]
fn bind_imports_matches() {
    for tree in TREES {
        let mut l = common::load(tree);
        l.bind();
        assert_eq!(l.text(bind_json(&l)), l.golden("bind.json"), "{tree}");
    }
}

#[test]
fn output_names_match() {
    for tree in TREES {
        let (l, renamed) = prepare(tree);
        assert_eq!(
            renamed,
            l.has_golden("rename.json"),
            "{tree}: rename only without errors"
        );
        if renamed {
            assert_eq!(l.text(rename_json(&l)), l.golden("rename.json"), "{tree}");
        }
    }
}

#[test]
fn namespace_members_resolve_like_the_oracle() {
    for tree in TREES {
        let (l, _) = prepare(tree);
        assert_rows(&l, &namespace_rows(&l), &["resolveNamespaceMember"]);
    }
}

#[test]
fn a_collision_takes_the_next_suffix() {
    let (l, renamed) = prepare("imports");
    assert!(renamed);
    let helpers: Vec<&str> = l
        .sides
        .iter()
        .filter_map(|s| s.rename.as_ref().and_then(|r| r.get("helper")))
        .map(String::as_str)
        .collect();
    assert_eq!(helpers, ["helper", "helper_2"]);
}

#[test]
fn a_missing_namespace_is_not_found() {
    let (l, _) = prepare("imports");
    let r = resolve_namespace_member(&l.sides, 0, "__none", "x", Table::Consts);
    assert!(!r.namespace_found && !r.member_found && r.value.is_none());
}

#[test]
fn a_module_without_declarations_gets_no_names() {
    let mut sides = vec![ModuleSide::default()];
    assign_output_names(&mut sides);
    assert_eq!(sides[0].rename.as_ref().map(|r| r.len()), Some(0));
}
