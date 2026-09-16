// Symbol binding: names, scopes, and duplicate detection before the checker.
//
// Pure over the AST — no filesystem. Component symbols are recorded here;
// component-specific rules run in bx/check.mjs after binding.
//
// An imported name is an Import symbol with no meaning of its own until
// the module it comes from has been bound too; bindImports() then points
// it at that module's exported symbol, so `<MenuBar />` in one file
// resolves to `component MenuBar` in another, and hover, completion and
// go-to-definition (src/intellisense/symbols.mjs) reach a function or a
// const the same way. The linker does this for the whole graph;
// analyze() and the editor do it one import deep.
//
// Scopes are a side table (`scopeOf`, node → scope) rather than a field
// on the node: the AST stays a tree for every pass that walks it.
import { NodeType, walk } from '../ast/index.mjs';

export const SymbolKind = Object.freeze({
  Variable: 'Variable',
  Constant: 'Constant',
  Function: 'Function',
  Namespace: 'Namespace',
  Parameter: 'Parameter',
  Import: 'Import',
  Component: 'Component',
  State: 'State',
});

/**
 * @typedef {object} Symbol
 * @property {string} name
 * @property {string} kind
 * @property {object} node
 * @property {object} scope
 * @property {object[]} [props]
 * @property {boolean} [allowsChildren]
 * @property {boolean} [exported]
 * @property {Symbol|null} [component]  for an Import: the Component it names, once bound across modules
 * @property {Symbol|null} [target]      for an Import: the exported symbol it names, once bound across modules
 * @property {string} [file]             the module the symbol is declared in
 * @property {object} [declaration]      the declaration node (the whole statement, parameter, or import specifier)
 * @property {string} [source]           for an Import: the specifier it came from
 * @property {string} [imported]         for an Import: the name in the other module
 */

function createScope(parent = null) {
  return { parent, symbols: new Map() };
}

function declare(scope, name, symbol, file) {
  symbol.file = file;
  if (scope.symbols.has(name)) return;
  scope.symbols.set(name, symbol);
}

function bindParameters(scope, params, file, diagnostics) {
  for (const param of params ?? []) {
    if (!param?.name) continue;
    declare(scope, param.name.name, {
      name: param.name.name,
      kind: SymbolKind.Parameter,
      node: param.name,
      scope,
      declaration: param,
    }, file);
  }
}

function bindBlock(scope, body, file, diagnostics, bindStatement) {
  const blockScope = createScope(scope);
  for (const stmt of body ?? []) {
    bindStatement(blockScope, stmt, file, diagnostics);
  }
  return blockScope;
}

/** The parser's `exported` flag on a declaration node, as a boolean. */
const isExported = (stmt) => stmt.exported === true;

/**
 * @param {object} ast
 * @param {string} file
 * @returns {{ scopes: object[], symbols: Map<string, Symbol>, imports: Symbol[], diagnostics: object[], scopeOf: Map<object, object>, file: string }}
 *   `scopeOf` takes a function, component or namespace declaration to the
 *   scope its parameters and members live in, and a block statement to its
 *   own — enough to find the scope any offset is in.
 */
export function bind(ast, file = '<unknown>') {
  const diagnostics = [];
  const moduleScope = createScope(null);
  const symbols = new Map();
  const imports = [];
  const scopeOf = new Map();
  const blockOf = (scope, node, body, f, diags, bindStatement) => {
    const blockScope = bindBlock(scope, body, f, diags, bindStatement);
    if (node) scopeOf.set(node, blockScope);
    return blockScope;
  };

  const bindStatement = (scope, stmt, f, diags) => {
    if (!stmt) return;
    switch (stmt.type) {
      case NodeType.ImportDeclaration: {
        // A specifier is the imported Identifier; `x as y` is that node
        // with `name` the local name and `imported` the other module's.
        for (const spec of stmt.specifiers ?? []) {
          const local = spec?.name;
          if (!local) continue;
          const sym = {
            name: local,
            kind: SymbolKind.Import,
            node: spec,
            scope,
            source: stmt.source?.value ?? null,
            imported: spec.imported ?? local,
            component: null,
            target: null,
          };
          declare(scope, local, sym, f);
          symbols.set(local, sym);
          imports.push(sym);
        }
        break;
      }
      case NodeType.VariableDeclaration: {
        if (!stmt.name?.name) break;
        const kind = stmt.kind === 'const' ? SymbolKind.Constant : SymbolKind.Variable;
        const sym = { name: stmt.name.name, kind, node: stmt.name, scope, exported: isExported(stmt), declaration: stmt };
        declare(scope, stmt.name.name, sym, f);
        symbols.set(stmt.name.name, sym);
        break;
      }
      case NodeType.FunctionDeclaration: {
        if (!stmt.name?.name) break;
        const sym = { name: stmt.name.name, kind: SymbolKind.Function, node: stmt.name, scope, exported: isExported(stmt), declaration: stmt };
        declare(scope, stmt.name.name, sym, f);
        symbols.set(stmt.name.name, sym);
        const fnScope = createScope(scope);
        scopeOf.set(stmt, fnScope);
        bindParameters(fnScope, stmt.params, f, diags);
        blockOf(fnScope, stmt.body, stmt.body?.body, f, diags, bindStatement);
        break;
      }
      case NodeType.NamespaceDeclaration: {
        if (!stmt.name?.name) break;
        const sym = { name: stmt.name.name, kind: SymbolKind.Namespace, node: stmt.name, scope, exported: isExported(stmt), declaration: stmt };
        declare(scope, stmt.name.name, sym, f);
        symbols.set(stmt.name.name, sym);
        // Members (the parser's `members`, not a block): the namespace's own scope.
        const nsScope = blockOf(scope, stmt, stmt.members, f, diags, bindStatement);
        sym.members = nsScope.symbols;
        break;
      }
      case NodeType.ComponentDeclaration: {
        if (!stmt.name?.name) break;
        const props = (stmt.params ?? []).map((p) => ({
          name: p.name?.name,
          typeAnnotation: p.typeAnnotation,
          optional: p.optional ?? false,
          defaultValue: p.defaultValue ?? null,
        }));
        const sym = {
          name: stmt.name.name,
          kind: SymbolKind.Component,
          node: stmt.name,
          scope,
          props,
          allowsChildren: stmt.allowsChildren ?? false,
          exported: stmt.exported ?? false,
          // The fields a `state` declaration names, top level of the body.
          state: (stmt.body?.body ?? [])
            .filter((s) => s?.type === NodeType.StateDeclaration && s.name?.name)
            .map((s) => s.name.name),
          body: stmt.body,
          declaration: stmt,
        };
        declare(scope, stmt.name.name, sym, f);
        symbols.set(stmt.name.name, sym);
        const compScope = createScope(scope);
        scopeOf.set(stmt, compScope);
        bindParameters(compScope, stmt.params, f, diags);
        blockOf(compScope, stmt.body, stmt.body?.body, f, diags, bindStatement);
        break;
      }
      case NodeType.StateDeclaration: {
        if (!stmt.name?.name) break;
        declare(scope, stmt.name.name, { name: stmt.name.name, kind: SymbolKind.State, node: stmt.name, scope, declaration: stmt }, f);
        break;
      }
      case NodeType.BlockStatement:
        blockOf(scope, stmt, stmt.body, f, diags, bindStatement);
        break;
      case NodeType.IfStatement:
        bindStatement(scope, stmt.consequent, f, diags);
        bindStatement(scope, stmt.alternate, f, diags);
        break;
      case NodeType.WhileStatement:
        bindStatement(scope, stmt.body, f, diags);
        break;
      case NodeType.ForStatement:
        bindStatement(scope, stmt.init, f, diags);
        bindStatement(scope, stmt.body, f, diags);
        break;
      default:
        break;
    }
  };

  if (ast?.type === NodeType.Program) {
    for (const stmt of ast.body ?? []) {
      bindStatement(moduleScope, stmt, file, diagnostics);
    }
  }

  return { scopes: [moduleScope], symbols, imports, diagnostics, scopeOf, file };
}

/**
 * The Component a symbol stands for: itself, or — for an Import bound
 * across modules — the one it names. Null for anything else, and for an
 * Import whose module has not been bound (see `resolveComponent`'s
 * `unresolved` answer for how the checker treats that).
 *
 * @param {Symbol|undefined|null} sym
 * @returns {Symbol|null}
 */
export function componentOf(sym) {
  if (!sym) return null;
  if (sym.kind === SymbolKind.Component) return sym;
  if (sym.kind === SymbolKind.Import && sym.component) return sym.component;
  return null;
}

/**
 * Point every Import symbol in `bound` that names an exported symbol of
 * another module at that symbol: `target` for any kind, `component` when
 * it is a Component. `lookup(source)` is the other module's own bind()
 * result, or null when the import did not resolve (that is reported
 * elsewhere, by the resolver).
 *
 * A non-exported name is not visible: the import stays an Import with no
 * target, and `<Name />` is then "not a component", which is what the
 * definer's `export` decides.
 *
 * @param {{ imports: Symbol[] }} bound
 * @param {(source: string) => ({ symbols: Map<string, Symbol>, file?: string } | null)} lookup
 */
export function bindImports(bound, lookup) {
  for (const sym of bound.imports) {
    if (!sym.source) continue;
    const other = lookup(sym.source);
    if (!other) continue;
    const target = other.symbols.get(sym.imported);
    sym.target = target?.exported ? target : null;
    sym.component = sym.target?.kind === SymbolKind.Component ? sym.target : null;
    sym.resolved = true;
  }
}

/** The older name of bindImports, kept for its callers. */
export const bindImportedComponents = bindImports;

/** Resolve a name starting in `scope`. */
export function resolveSymbol(scope, name) {
  for (let s = scope; s; s = s.parent) {
    const hit = s.symbols.get(name);
    if (hit) return hit;
  }
  return null;
}
