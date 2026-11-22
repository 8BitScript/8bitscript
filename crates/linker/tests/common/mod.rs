//! Shared by the linker's fixture tests: load a tree the way the gen script
//! (`gen/linker-scope.mjs`) does, run the passes in its order, and write what they hold in the
//! shape of its golden files.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use diagnostics::{Diagnostic, Severity};
use front::graph::{LoadedGraph, load_graph};
use front::module::{LinkOptions, canonical};
use indexmap::IndexMap;
use linker::consts::{Callee, Visible, check_string_fits, visible_consts};
use linker::imports::{
    MemberValue, Table, assign_output_names, bind_imports, resolve_namespace_member,
};
use linker::scope::{
    Scope, bind_local, child_scope, global_named, is_imported_name, is_string_name,
};
use linker::{ConstValue, ModuleSide, ir_of};
use mos_ir::{Expr, IrString, StringLiteral};
use serde_json::{Map, Value, json};

pub const TREES: [&str; 6] = ["imports", "errors", "consts", "facts", "strings", "natives"];

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

pub fn fixture(tree: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(tree)
}

/// One tree, loaded: the graph, the diagnostics so far and the linker's side tables.
pub struct Loaded {
    pub tree: String,
    pub graph: LoadedGraph,
    pub diagnostics: Vec<Diagnostic>,
    pub sides: Vec<ModuleSide>,
    toolchain: String,
    project: String,
    _scratch: Scratch,
}

pub fn load(tree: &str) -> Loaded {
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("linker-{tree}-{}-{id}", std::process::id()));
    copy_tree(&fixture(tree).join("src"), &dir);
    let scratch = Scratch(dir.clone());
    let project = canonical(&dir.to_string_lossy());
    let toolchain = canonical(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .to_string_lossy(),
    );
    let entry = format!("{project}/main.8bs");
    let text = fs::read_to_string(&entry).unwrap();
    let mut link = LinkOptions::default();
    link.spec.base.machine = Some("c64".to_string());
    link.spec.checkout = Some(toolchain.clone());
    link.facts = Some(Default::default());
    let mut diagnostics = Vec::new();
    let graph = load_graph(&text, &entry, &mut diagnostics, &link, None).unwrap();
    let sides = ModuleSide::for_graph(&graph);
    Loaded {
        tree: tree.to_string(),
        graph,
        diagnostics,
        sides,
        toolchain,
        project,
        _scratch: scratch,
    }
}

impl Loaded {
    /// `bindImports(modules, diagnostics)`.
    pub fn bind(&mut self) {
        bind_imports(&self.graph, &mut self.sides, &mut self.diagnostics);
    }

    /// `hasError(diagnostics)`.
    pub fn errored(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|d| d.severity != Severity::Warning)
    }

    /// `assignOutputNames`, when nothing failed; whether it ran.
    pub fn rename(&mut self) -> bool {
        if self.errored() {
            return false;
        }
        assign_output_names(&mut self.sides);
        true
    }

    /// What `resolvePendingConsts` leaves on a module's `constValues` and `constTypes`.
    pub fn set_const_values(&mut self) {
        for m in 0..self.sides.len() {
            let Visible { values, types } = visible_consts(&self.sides, m, false);
            self.sides[m].const_values = values;
            self.sides[m].const_types = types;
        }
    }

    /// The text of a golden file's value, paths tokenized.
    pub fn text(&self, value: Value) -> String {
        let roots = oracle::Roots {
            toolchain: &self.toolchain,
            project: &self.project,
        };
        oracle::canonical_json(&tokenize(value, &roots))
    }

    pub fn golden(&self, file: &str) -> String {
        let path = fixture(&self.tree).join("golden").join(file);
        fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    pub fn has_golden(&self, file: &str) -> bool {
        fixture(&self.tree).join("golden").join(file).exists()
    }

    /// The golden rows of `fn_name`, in file order, as canonical text.
    pub fn golden_rows(&self, fn_name: &str) -> String {
        let rows: Value = serde_json::from_str(&self.golden("rows.json")).unwrap();
        let kept: Vec<Value> = rows
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["fn"] == fn_name)
            .cloned()
            .collect();
        self.text(Value::Array(kept))
    }

    pub fn file_of(&self, m: usize) -> &str {
        linker::file_of(&self.graph, m)
    }
}

fn tokenize(value: Value, roots: &oracle::Roots) -> Value {
    match value {
        Value::String(s) => Value::String(oracle::tokenize_path(&s, roots)),
        Value::Array(items) => {
            Value::Array(items.into_iter().map(|v| tokenize(v, roots)).collect())
        }
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, tokenize(v, roots)))
                .collect::<Map<String, Value>>(),
        ),
        other => other,
    }
}

/// A JS number: an integer as an integer.
pub fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        Value::from(n as i64)
    } else {
        Value::from(n)
    }
}

pub fn const_json(value: &ConstValue) -> Value {
    match value {
        ConstValue::Number(n) => num(*n),
        ConstValue::String { string } => json!({ "string": string }),
        ConstValue::Pending { pending, ty } => {
            json!({ "pending": serde_json::to_value(pending).unwrap(), "type": ty })
        }
    }
}

fn pairs<V>(map: &IndexMap<String, V>, f: impl Fn(&V) -> Value) -> Value {
    Value::Array(map.iter().map(|(k, v)| json!([k, f(v)])).collect())
}

fn keys<V>(map: &IndexMap<String, V>) -> Value {
    Value::Array(map.keys().map(|k| json!(k)).collect())
}

fn bindings(map: &Option<IndexMap<String, linker::Binding>>) -> Value {
    match map {
        Some(map) => pairs(map, |b| json!({ "module": b.module, "name": b.name })),
        None => json!([]),
    }
}

pub fn natives_json(l: &Loaded) -> Value {
    json!(l.graph.native_sources)
}

pub fn imports_json(l: &Loaded) -> Value {
    let files: Vec<&str> = l.graph.modules.iter().map(|m| m.file.as_str()).collect();
    json!({ "modules": files, "imports": l.graph.import_modules })
}

pub fn facts_json(l: &Loaded) -> Value {
    json!(linker::consts::tested_facts(&l.graph))
}

pub fn bind_json(l: &Loaded) -> Value {
    let modules: Vec<Value> = l
        .sides
        .iter()
        .map(|s| {
            json!({
                "decls": pairs(&s.decls, |b| json!(b)),
                "globalsByName": keys(&s.globals_by_name),
                "namespaces": keys(&s.namespaces),
                "ownConsts": pairs(&s.own_consts, const_json),
                "ownConstTypes": pairs(&s.own_const_types, |t| json!(t)),
                "bindings": bindings(&s.bindings),
                "namespaceBindings": bindings(&s.namespace_bindings),
            })
        })
        .collect();
    json!({ "modules": modules, "diagnostics": serde_json::to_value(&l.diagnostics).unwrap() })
}

pub fn rename_json(l: &Loaded) -> Value {
    Value::Array(
        l.sides
            .iter()
            .map(|s| pairs(s.rename.as_ref().unwrap(), |t| json!(t)))
            .collect(),
    )
}

pub fn visible_json(l: &Loaded) -> Value {
    let one = |v: Visible| json!({ "values": pairs(&v.values, const_json), "types": pairs(&v.types, |t| json!(t)) });
    Value::Array(
        (0..l.sides.len())
            .map(|m| {
                json!({
                    "all": one(visible_consts(&l.sides, m, false)),
                    "settled": one(visible_consts(&l.sides, m, true)),
                })
            })
            .collect(),
    )
}

fn row(fn_name: &str, args: Value, result: Value) -> Value {
    json!({ "fn": fn_name, "args": args, "result": result })
}

/// `resolveNamespaceMember` rows.
pub fn namespace_rows(l: &Loaded) -> Vec<Value> {
    let mut rows = Vec::new();
    for (m, side) in l.sides.iter().enumerate() {
        let mut spaces: Vec<String> = side.namespaces.keys().cloned().collect();
        for k in side.namespace_bindings.iter().flat_map(|b| b.keys()) {
            if !spaces.contains(k) {
                spaces.push(k.clone());
            }
        }
        spaces.push("__none".to_string());
        for ns in &spaces {
            let own = side.namespaces.get(ns);
            let bound = side
                .namespace_bindings
                .as_ref()
                .and_then(|b| b.get(ns))
                .and_then(|b| l.sides[b.module].namespaces.get(&b.name));
            let target = own.or(bound);
            for (table, name) in [(Table::Functions, "functions"), (Table::Consts, "consts")] {
                let mut members: Vec<String> = Vec::new();
                if let Some(t) = target {
                    members.extend(t.functions.keys().cloned());
                    members.extend(t.consts.keys().cloned());
                }
                members.push("__missing".to_string());
                let mut seen: Vec<String> = Vec::new();
                for member in members {
                    if seen.contains(&member) {
                        continue;
                    }
                    seen.push(member.clone());
                    let r = resolve_namespace_member(&l.sides, m, ns, &member, table);
                    let mut result = Map::new();
                    result.insert("namespaceFound".into(), json!(r.namespace_found));
                    if r.namespace_found {
                        result.insert("memberFound".into(), json!(r.member_found));
                        if let Some(v) = &r.value {
                            result.insert(
                                "value".into(),
                                match v {
                                    MemberValue::Function(f) => json!(f),
                                    MemberValue::Const(c) => const_json(c),
                                },
                            );
                        }
                        if let Some(t) = &r.ty {
                            result.insert("type".into(), json!(t));
                        }
                        if let Some(t) = r.target_module {
                            result.insert("targetModule".into(), json!(t));
                        }
                    }
                    rows.push(row(
                        "resolveNamespaceMember",
                        json!([m, ns, member, name]),
                        Value::Object(result),
                    ));
                }
            }
        }
    }
    rows
}

/// `globalNamed`, `isImportedName` and `isStringName` rows, one name after the other.
pub fn scope_rows(l: &Loaded) -> Vec<Value> {
    let mut rows = Vec::new();
    for (m, side) in l.sides.iter().enumerate() {
        let mut scope = child_scope(&Scope::new(side.rename.clone().unwrap_or_default()));
        bind_local(&mut scope, "p");
        let mut ids: Vec<String> = side.decls.keys().cloned().collect();
        ids.extend(side.bindings.iter().flat_map(|b| b.keys().cloned()));
        ids.push("p".into());
        ids.push("__missing".into());
        for id in ids {
            let global = global_named(&l.graph, &l.sides, m, &id);
            rows.push(row(
                "globalNamed",
                json!([m, id]),
                global.map_or(Value::Null, |g| serde_json::to_value(g).unwrap()),
            ));
            rows.push(row(
                "isImportedName",
                json!([m, id]),
                json!(is_imported_name(&l.sides, m, &scope, &id)),
            ));
            rows.push(row(
                "isStringName",
                json!([m, id]),
                json!(is_string_name(&l.graph, &l.sides, m, &scope, &id)),
            ));
        }
    }
    rows
}

/// `constExpression` and `checkStringFits` rows.
pub fn const_rows(l: &Loaded) -> Vec<Value> {
    let mut rows = Vec::new();
    for (m, side) in l.sides.iter().enumerate() {
        for (name, value) in &side.own_consts {
            if value.is_pending() {
                continue;
            }
            let ty = side.own_const_types.get(name);
            let expr = linker::consts::const_expression(value, ty.map(String::as_str)).unwrap();
            rows.push(row(
                "constExpression",
                json!([const_json(value), ty]),
                serde_json::to_value(&expr).unwrap(),
            ));
        }
        let _ = m;
    }
    for m in 0..l.sides.len() {
        let strings: &[IrString] = &ir_of(&l.graph, m).strings;
        for slot in 0..strings.len() {
            let mut found = Vec::new();
            let source = Expr::String(StringLiteral {
                index: slot as i64,
                ty: jsnum::Nullable::Absent,
                start: None,
                length: None,
            });
            check_string_fits(&source, 4, strings, l.file_of(m), &mut found);
            rows.push(row(
                "checkStringFits",
                json!([m, slot, 4]),
                serde_json::to_value(&found).unwrap(),
            ));
        }
    }
    rows
}

fn collect_calls(value: &Value, out: &mut Vec<Value>) {
    match value {
        Value::Array(items) => items.iter().for_each(|v| collect_calls(v, out)),
        Value::Object(map) => {
            if map.get("kind") == Some(&json!("call"))
                && map.get("args").is_some_and(Value::is_array)
                && map.get("name").is_some_and(Value::is_string)
            {
                out.push(value.clone());
            }
            map.values().for_each(|v| collect_calls(v, out));
        }
        _ => {}
    }
}

/// `completeCall` rows; only once the output names are assigned.
pub fn complete_call_rows(l: &Loaded) -> Vec<Value> {
    let mut callees: IndexMap<String, Callee> = IndexMap::new();
    for (m, side) in l.sides.iter().enumerate() {
        let rename = side.rename.as_ref().unwrap();
        for f in &ir_of(&l.graph, m).functions {
            callees.insert(
                rename[&f.name].clone(),
                Callee {
                    params: f.params.clone(),
                    return_type: f.return_type.clone(),
                },
            );
        }
    }
    let mut rows = Vec::new();
    for m in 0..l.sides.len() {
        for f in &ir_of(&l.graph, m).functions {
            let mut found_calls = Vec::new();
            collect_calls(&serde_json::to_value(&f.body).unwrap(), &mut found_calls);
            for call in found_calls {
                let args = call["args"].clone();
                let triple = Value::Array(
                    args.as_array()
                        .unwrap()
                        .iter()
                        .cloned()
                        .cycle()
                        .take(args.as_array().unwrap().len() * 3)
                        .collect(),
                );
                for variant in [args.clone(), json!([]), triple] {
                    let mut input = call.clone();
                    input["args"] = variant;
                    let Expr::Call(mut done) =
                        serde_json::from_value::<Expr>(input.clone()).unwrap()
                    else {
                        panic!("not a call");
                    };
                    let mut found = Vec::new();
                    linker::consts::complete_call(
                        &mut done,
                        None,
                        Some(&callees),
                        l.file_of(m),
                        &mut found,
                    );
                    rows.push(row(
                        "completeCall",
                        json!([m, input]),
                        json!({
                            "call": serde_json::to_value(Expr::Call(done)).unwrap(),
                            "diagnostics": serde_json::to_value(&found).unwrap(),
                        }),
                    ));
                }
            }
        }
    }
    // The gen script orders these by the canonical text of the arguments.
    rows.sort_by_key(|r| oracle::canonical_json(&r["args"]));
    rows
}

/// Runs the passes in the gen script's order: bind, then output names when nothing failed, then
/// the const values rows read.
pub fn prepare(tree: &str) -> (Loaded, bool) {
    let mut l = load(tree);
    l.bind();
    let renamed = l.rename();
    l.set_const_values();
    (l, renamed)
}

/// Asserts that the rows of each function equal the golden ones.
pub fn assert_rows(l: &Loaded, rows: &[Value], fn_names: &[&str]) {
    for name in fn_names {
        let got: Vec<Value> = rows.iter().filter(|r| r["fn"] == *name).cloned().collect();
        assert_eq!(
            l.text(Value::Array(got)),
            l.golden_rows(name),
            "{}: {name}",
            l.tree
        );
    }
}
