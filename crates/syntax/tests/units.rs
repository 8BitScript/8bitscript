use syntax::{
    Node, NodeKind, SOURCE_EXTENSIONS, SourceKind, Span, children, number_nodes, utf16_len, walk,
};

fn ident(name: &str, start: u32) -> Node {
    Node::new(
        start,
        start + u32::try_from(name.len()).expect("small"),
        NodeKind::Identifier {
            name: name.into(),
            compile_time: None,
            imported: None,
        },
    )
}

#[test]
fn new_computes_length_and_saturates() {
    let n = Node::new(5, 9, NodeKind::BreakStatement {});
    assert_eq!((n.start, n.length), (5, 4));
    assert_eq!(Node::new(9, 5, NodeKind::BreakStatement {}).length, 0);
    assert_eq!(n.type_name(), "BreakStatement");
}

#[test]
fn spans() {
    let s = Span::from_range(2, 10);
    assert_eq!((s.start, s.length, s.end()), (2, 8, 10));
    assert_eq!(Span::from_range(10, 2).length, 0);
    assert_eq!(Span::new(u32::MAX, 5).end(), u32::MAX);
    assert_eq!(utf16_len("a\u{1F600}\u{e9}"), 4);
}

#[test]
fn decorators_come_last_and_none_children_are_skipped() {
    let call = Node::new(
        0,
        10,
        NodeKind::CallExpression {
            callee: Box::new(ident("f", 0)),
            args: vec![ident("a", 2)],
            instance: None,
        },
    );
    let mut stmt = Node::new(
        0,
        10,
        NodeKind::IfStatement {
            test: Some(Box::new(call)),
            consequent: None,
            alternate: Some(Box::new(ident("z", 9))),
        },
    );
    stmt.decorators = Some(vec![Node::new(
        0,
        1,
        NodeKind::Decorator {
            name: "unroll".into(),
            args: vec![],
        },
    )]);
    let kinds: Vec<&str> = children(&stmt).iter().map(|n| n.type_name()).collect();
    assert_eq!(kinds, ["CallExpression", "Identifier", "Decorator"]);
    let mut order = Vec::new();
    walk(&stmt, &mut |n, _| order.push(n.type_name()));
    assert_eq!(
        order,
        [
            "IfStatement",
            "CallExpression",
            "Identifier",
            "Identifier",
            "Identifier",
            "Decorator"
        ]
    );
    assert_eq!(number_nodes(&mut stmt), 6);
}

#[test]
fn source_kinds() {
    assert_eq!(SOURCE_EXTENSIONS, [".8bs", ".8bx", ".8bg", ".8ba"]);
    for kind in SourceKind::ALL {
        assert_eq!(SourceKind::from_extension(kind.as_str()), Some(kind));
    }
    assert_eq!(SourceKind::from_extension(".js"), None);
}
