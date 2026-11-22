//! Port of packages/compiler/src/linker/index.mjs:260-682: the scope, const and import passes of
//! the linker. [`scope`] is the name lookup, [`consts`] the compile-time values, [`imports`] the
//! binding of one module's imports to another module's declarations. [`rewrite`] holds the one
//! pass of a later unit that these call (R0.5).
//!
//! JS keeps these tables on the module objects themselves (`module.decls`, `module.bindings`, ...).
//! Here they are a [`ModuleSide`] per module, in a `Vec` indexed like `LoadedGraph::modules`
//! (R1.3); a binding names its module by that index.

use std::sync::LazyLock;

use indexmap::IndexMap;
use lower::module::ModuleIr;
use mos_ir::Expr;

pub mod consts;
pub mod imports;
pub mod rewrite;
pub mod scope;

/// The marker a stub returns for a path that a later unit ports (R0.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unported;

/// `{ module, name }`: a name another module declares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub module: usize,
    pub name: String,
}

/// A const's value: a number, a slot of a string table (`{ string }`), or an initializer only the
/// linker can see (`{ pending, type }`).
#[derive(Debug, Clone, PartialEq)]
pub enum ConstValue {
    Number(f64),
    String { string: i64 },
    Pending { pending: Box<Expr>, ty: String },
}

impl ConstValue {
    /// JS `typeof value === 'object'`: a string slot or a pending initializer.
    #[must_use]
    pub fn is_object(&self) -> bool {
        !matches!(self, ConstValue::Number(_))
    }

    /// JS `value?.pending`.
    #[must_use]
    pub fn is_pending(&self) -> bool {
        matches!(self, ConstValue::Pending { .. })
    }
}

/// A module's own namespace declaration, with its consts as linker values. Owned by the side
/// table because `resolvePendingConsts` settles them in place.
#[derive(Debug, Clone, PartialEq)]
pub struct Namespace {
    pub name: String,
    pub exported: bool,
    pub functions: IndexMap<String, String>,
    pub consts: IndexMap<String, ConstValue>,
    pub const_types: IndexMap<String, String>,
    pub start: i64,
    pub length: i64,
}

/// What the linker keeps on a module beside its IR.
#[derive(Debug, Clone, Default)]
pub struct ModuleSide {
    /// `module.decls`: every top-level name, to whether it is exported.
    pub decls: IndexMap<String, bool>,
    /// `module.globalsByName`: a name to its index in `ir.globals`.
    pub globals_by_name: IndexMap<String, usize>,
    pub namespaces: IndexMap<String, Namespace>,
    pub own_consts: IndexMap<String, ConstValue>,
    pub own_const_types: IndexMap<String, String>,
    /// Not set until `bind_imports` ran.
    pub bindings: Option<IndexMap<String, Binding>>,
    pub namespace_bindings: Option<IndexMap<String, Binding>>,
    /// Not set until `assign_output_names` ran.
    pub rename: Option<IndexMap<String, String>>,
    /// What a reference inlines from (set by `resolve_pending_consts`).
    pub const_values: IndexMap<String, ConstValue>,
    pub const_types: IndexMap<String, String>,
    /// A slot of the module's string table to the program's (set when linking).
    pub string_map: Vec<usize>,
}

impl ModuleSide {
    /// One empty side per module of the graph.
    #[must_use]
    pub fn for_graph(graph: &front::graph::LoadedGraph) -> Vec<ModuleSide> {
        graph.modules.iter().map(|_| ModuleSide::default()).collect()
    }
}

static NO_IR: LazyLock<ModuleIr> = LazyLock::new(ModuleIr::default);

/// The IR of module `module`. A module with none reads as an empty one, where JS would throw on
/// `module.ir.globals`; `loadGraph` finishes every module it returns, so none lacks it.
#[must_use]
pub fn ir_of(graph: &front::graph::LoadedGraph, module: usize) -> &ModuleIr {
    graph
        .modules
        .get(module)
        .and_then(|m| m.ir.as_ref())
        .unwrap_or(&NO_IR)
}

/// The file of module `module`.
#[must_use]
pub fn file_of(graph: &front::graph::LoadedGraph, module: usize) -> &str {
    graph.modules.get(module).map_or("", |m| m.file.as_str())
}

/// A span number as the diagnostic's `u32`: negative reads as 0, a too-large one saturates (R2.1).
#[must_use]
pub fn span(n: Option<i64>) -> u32 {
    u32::try_from(n.unwrap_or(0).max(0)).unwrap_or(u32::MAX)
}

/// `start` and `length` of an IR expression that carries a span (`expr.start ?? 0`).
#[must_use]
pub fn span_of(expr: &Expr) -> (Option<i64>, Option<i64>) {
    match expr {
        Expr::Ref(e) => (e.start, e.length),
        Expr::Call(e) => (e.start, e.length),
        Expr::String(e) => (e.start, e.length),
        Expr::StringLength(e) => (e.start, e.length),
        Expr::NamespaceCall(e) => (e.start, e.length),
        Expr::NamespaceConst(e) => (Some(e.start), Some(e.length)),
        _ => (None, None),
    }
}
