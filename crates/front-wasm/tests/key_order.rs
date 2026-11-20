//! The key order of `parse_json`'s `ast` (R1.9): each node writes its
//! node-valued keys in `syntax::children` order, with `decorators` last, so
//! the JSON a JS reader gets walks the same way the Rust walker does.

use std::fmt;
use std::fs;
use std::path::PathBuf;

use front_wasm::parse_json;
use serde::Deserialize;
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::json;
use syntax::{Node, children};

/// A JSON value that keeps object keys in the order they were written.
enum Ordered {
    Object(Vec<(String, Ordered)>),
    Array(Vec<Ordered>),
    Text(String),
    Number(u64),
    Other,
}

impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Ordered;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Ordered, A::Error> {
                let mut entries = Vec::new();
                while let Some(key) = m.next_key::<String>()? {
                    entries.push((key, m.next_value()?));
                }
                Ok(Ordered::Object(entries))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut s: A) -> Result<Ordered, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = s.next_element()? {
                    items.push(item);
                }
                Ok(Ordered::Array(items))
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Ordered, E> {
                Ok(Ordered::Other)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Ordered, E> {
                Ok(Ordered::Other)
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Ordered, E> {
                Ok(Ordered::Number(v))
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Ordered, E> {
                Ok(Ordered::Other)
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Ordered, E> {
                Ok(Ordered::Text(v.to_string()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Ordered, E> {
                Ok(Ordered::Other)
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Deserialize)]
struct Reply {
    ast: Ordered,
}

/// `(type, start)` when the value is a node object.
fn identity(value: &Ordered) -> Option<(&str, u64)> {
    let Ordered::Object(entries) = value else {
        return None;
    };
    let get = |k: &str| entries.iter().find(|(key, _)| key == k).map(|(_, v)| v);
    match (get("type")?, get("start")?, get("length")) {
        (Ordered::Text(t), Ordered::Number(n), Some(_)) => Some((t, *n)),
        _ => None,
    }
}

/// The node-valued keys of `value` in written order, arrays flattened.
fn json_children(value: &Ordered) -> Vec<&Ordered> {
    let Ordered::Object(entries) = value else {
        panic!("a node is not an object");
    };
    let mut out = Vec::new();
    for (_, v) in entries {
        match v {
            Ordered::Array(items) => out.extend(items.iter().filter(|i| identity(i).is_some())),
            _ if identity(v).is_some() => out.push(v),
            _ => {}
        }
    }
    out
}

/// Check one node and everything under it; returns how many nodes it saw.
fn check(ordered: &Ordered, node: &Node, at: &str) -> usize {
    assert_eq!(
        identity(ordered),
        Some((node.type_name(), u64::from(node.start))),
        "{at}"
    );
    let written = json_children(ordered);
    let walked = children(node);
    let names = |v: &[&Ordered]| -> Vec<(String, u64)> {
        v.iter()
            .map(|n| {
                let (t, s) = identity(n).unwrap();
                (t.to_string(), s)
            })
            .collect()
    };
    let expected: Vec<(String, u64)> = walked
        .iter()
        .map(|n| (n.type_name().to_string(), u64::from(n.start)))
        .collect();
    assert_eq!(
        names(&written),
        expected,
        "{at}: written order differs from `syntax::children` for {}",
        node.type_name()
    );
    let mut seen = 1;
    for (w, t) in written.iter().zip(&walked) {
        seen += check(w, t, &format!("{at}/{}", t.type_name()));
    }
    if node.decorators.is_some() {
        let Ordered::Object(entries) = ordered else {
            unreachable!()
        };
        let last = entries.last().map(|(k, _)| k.as_str());
        assert_eq!(last, Some("decorators"), "{at}: decorators is not last");
    }
    seen
}

fn run(name: &str, file: &str, text: &str) -> usize {
    let kind = if file.ends_with(".8bx") {
        ".8bx"
    } else {
        ".8bs"
    };
    let request = json!({"file": file, "text": text, "sourceKind": kind});
    let bytes = parse_json(&serde_json::to_vec(&request).unwrap());
    let reply: Reply = serde_json::from_slice(&bytes).expect("ordered reply");
    #[derive(Deserialize)]
    struct Typed {
        ast: Node,
    }
    let typed: Typed = serde_json::from_slice(&bytes).expect("typed reply");
    check(&reply.ast, &typed.ast, name)
}

#[test]
fn every_pair_input_writes_children_in_walk_order() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/pairs");
    let mut files: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let n = p.file_name().unwrap().to_string_lossy().to_string();
            (n.ends_with(".8bs") || n.ends_with(".8bx")) && !n.contains(".old.")
        })
        .collect();
    files.sort();
    assert!(!files.is_empty());
    let mut nodes = 0;
    for path in &files {
        let text = fs::read_to_string(path).unwrap();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        nodes += run(&name, &name, &text);
    }
    assert!(nodes > 1000, "only {nodes} nodes checked");
}

#[test]
fn a_decorated_declaration_writes_decorators_last() {
    let text = "#[address($D020)] let mut border: volatile<u8>;\n";
    let nodes = run("decorated", "d.8bs", text);
    assert!(nodes > 2);
    let request = json!({"file": "d.8bs", "text": text, "sourceKind": ".8bs"});
    let bytes = parse_json(&serde_json::to_vec(&request).unwrap());
    assert!(String::from_utf8(bytes).unwrap().contains("\"decorators\""));
}
