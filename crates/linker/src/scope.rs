//! Port of packages/compiler/src/linker/index.mjs:324-352 and :564-569: the lookups a function's
//! scope answers.

use front::graph::LoadedGraph;
use indexmap::{IndexMap, IndexSet};
use mos_ir::Global;

use crate::{ConstValue, ModuleSide, ir_of};

/// A JS `Map` of local name to output name, with the `bound` set a scope may carry. A child is a
/// copy: it has no link to the scope it came from, and what it binds goes out of scope with it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Scope {
    pub names: IndexMap<String, String>,
    /// The names a parameter or local binds in the function; `None` until the first is bound.
    pub bound: Option<IndexSet<String>>,
}

impl Scope {
    /// `new Map(names)`: no `bound`.
    #[must_use]
    pub fn new(names: IndexMap<String, String>) -> Scope {
        Scope { names, bound: None }
    }

    /// `scope.has(name)`.
    #[must_use]
    pub fn has(&self, name: &str) -> bool {
        self.names.contains_key(name)
    }

    /// `scope.bound?.has(name)`.
    #[must_use]
    pub fn is_bound(&self, name: &str) -> bool {
        self.bound.as_ref().is_some_and(|b| b.contains(name))
    }
}

/// `globalNamed`: the global a name in `module` refers to, its own or the one an import binds.
#[must_use]
pub fn global_named<'a>(
    graph: &'a LoadedGraph,
    sides: &[ModuleSide],
    module: usize,
    name: &str,
) -> Option<&'a Global> {
    if let Some(&at) = sides[module].globals_by_name.get(name) {
        return ir_of(graph, module).globals.get(at);
    }
    let binding = sides[module].bindings.as_ref()?.get(name)?;
    let at = *sides[binding.module].globals_by_name.get(&binding.name)?;
    ir_of(graph, binding.module).globals.get(at)
}

/// `isImportedName`: does `name`, in this function's scope, refer to something another module
/// declares?
#[must_use]
pub fn is_imported_name(sides: &[ModuleSide], module: usize, scope: &Scope, name: &str) -> bool {
    !sides[module].globals_by_name.contains_key(name)
        && !scope.is_bound(name)
        && sides[module]
            .bindings
            .as_ref()
            .is_some_and(|b| b.contains_key(name))
}

/// `childScope`: the enclosing names, plus whatever locals the block declares.
#[must_use]
pub fn child_scope(scope: &Scope) -> Scope {
    Scope {
        names: scope.names.clone(),
        bound: Some(scope.bound.clone().unwrap_or_default()),
    }
}

/// `bindLocal`: a parameter or local is never renamed and shadows everything else of the name.
pub fn bind_local(scope: &mut Scope, name: &str) {
    scope.names.insert(name.to_string(), name.to_string());
    scope
        .bound
        .get_or_insert_with(IndexSet::new)
        .insert(name.to_string());
}

/// `isStringName`: is `name` a string in this scope: a parameter or local, a string const, or a
/// `string<N>` variable?
#[must_use]
pub fn is_string_name(
    graph: &LoadedGraph,
    sides: &[ModuleSide],
    module: usize,
    scope: &Scope,
    name: &str,
) -> bool {
    if scope.is_bound(name) {
        return true;
    }
    if sides[module]
        .const_values
        .get(name)
        .is_some_and(ConstValue::is_object)
    {
        return true;
    }
    global_named(graph, sides, module, name)
        .and_then(|g| g.string_capacity)
        .is_some_and(|capacity| capacity != 0)
}
