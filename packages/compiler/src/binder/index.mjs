// Symbol binding: names, scopes, and duplicate detection before the checker.
//
// Pure over the AST — no filesystem. Component symbols are recorded here;
// component-specific rules run in bx/check.mjs after binding.
//
// An imported name is an Import symbol with no meaning of its own until
// the module it comes from has been bound too; bindImportedComponents()
// then points it at that module's Component symbol, so `<MenuBar />` in
// one file resolves to `component MenuBar` in another. The linker does
// this for the whole graph; analyze() does it one import deep.
import { NodeType, walk } from '../ast/index.mjs';

export const SymbolKind = Object.freeze({
  Variable: 'Variable',
  Constant: 'Constant',
  Function: 'Function',
  Namespace: 'Namespace',
  Parameter: 'Parameter',
  Import: 'Import',
  Component: 'Component',
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
 * @property {string} [source]           for an Import: the specifier it came from
 * @property {string} [imported]         for an Import: the name in the other module
 */

function createScope(parent = null) {
  return { parent, symbols: new Map() };
}

function declare(scope, name, symbol) {
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
    });
  }
}

function bindBlock(scope, body, file, diagnostics, bindStatement) {
  const blockScope = createScope(scope);
  for (const stmt of body ?? []) {
    bindStatement(blockScope, stmt, file, diagnostics);
  }
  return blockScope;
}

/**
 * @param {object} ast
 * @param {string} file
 * @returns {{ scopes: object[], symbols: Map<string, Symbol>, imports: Symbol[], diagnostics: object[] }}
 */
export function bind(ast, file = '<unknown>') {
  const diagnostics = [];
  const moduleScope = createScope(null);
  const symbols = new Map();
  const imports = [];

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
          };
          declare(scope, local, sym);
          symbols.set(local, sym);
          imports.push(sym);
        }
        break;
      }
      case NodeType.VariableDeclaration: {
        if (!stmt.name?.name) break;
        const kind = stmt.kind === 'const' ? SymbolKind.Constant : SymbolKind.Variable;
        const sym = { name: stmt.name.name, kind, node: stmt.name, scope };
        declare(scope, stmt.name.name, sym);
        symbols.set(stmt.name.name, sym);
        break;
      }
      case NodeType.FunctionDeclaration: {
        if (!stmt.name?.name) break;
        const sym = { name: stmt.name.name, kind: SymbolKind.Function, node: stmt.name, scope };
        declare(scope, stmt.name.name, sym);
        symbols.set(stmt.name.name, sym);
        const fnScope = createScope(scope);
        bindParameters(fnScope, stmt.params, f, diags);
        bindBlock(fnScope, stmt.body?.body, f, diags, bindStatement);
        break;
      }
      case NodeType.NamespaceDeclaration: {
        if (!stmt.name?.name) break;
        const sym = { name: stmt.name.name, kind: SymbolKind.Namespace, node: stmt.name, scope };
        declare(scope, stmt.name.name, sym);
        symbols.set(stmt.name.name, sym);
        const nsScope = createScope(scope);
        bindBlock(nsScope, stmt.body?.body, f, diags, bindStatement);
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
          body: stmt.body,
        };
        declare(scope, stmt.name.name, sym);
        symbols.set(stmt.name.name, sym);
        const compScope = createScope(scope);
        bindParameters(compScope, stmt.params, f, diags);
        bindBlock(compScope, stmt.body?.body, f, diags, bindStatement);
        break;
      }
      case NodeType.BlockStatement:
        bindBlock(scope, stmt.body, f, diags, bindStatement);
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

  return { scopes: [moduleScope], symbols, imports, diagnostics };
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
 * Point every Import symbol in `bound` that names an exported component
 * of another module at that module's Component symbol. `lookup(source)`
 * is the other module's own bind() result, or null when the import did
 * not resolve (that is reported elsewhere, by the resolver).
 *
 * A non-exported component is not visible: the import stays an Import
 * with no component, and `<Name />` is then "not a component", which is
 * what the definer's `export` decides.
 *
 * @param {{ imports: Symbol[] }} bound
 * @param {(source: string) => ({ symbols: Map<string, Symbol> } | null)} lookup
 */
export function bindImportedComponents(bound, lookup) {
  for (const sym of bound.imports) {
    if (!sym.source) continue;
    const other = lookup(sym.source);
    if (!other) continue;
    const target = other.symbols.get(sym.imported);
    sym.component = target?.kind === SymbolKind.Component && target.exported ? target : null;
    sym.resolved = true;
  }
}

/** Resolve a name starting in `scope`. */
export function resolveSymbol(scope, name) {
  for (let s = scope; s; s = s.parent) {
    const hit = s.symbols.get(name);
    if (hit) return hit;
  }
  return null;
}
