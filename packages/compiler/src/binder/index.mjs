// Symbol binding: names, scopes, and duplicate detection before the checker.
//
// Pure over the AST — no filesystem. Component symbols are recorded here;
// component-specific rules run in bx/check.mjs after binding.
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
 * @returns {{ scopes: object[], symbols: Map<string, Symbol>, diagnostics: object[] }}
 */
export function bind(ast, file = '<unknown>') {
  const diagnostics = [];
  const moduleScope = createScope(null);
  const symbols = new Map();

  const bindStatement = (scope, stmt, f, diags) => {
    if (!stmt) return;
    switch (stmt.type) {
      case NodeType.ImportDeclaration: {
        for (const spec of stmt.specifiers ?? []) {
          const local = spec.local?.name ?? spec.imported?.name;
          if (!local) continue;
          const sym = {
            name: local, kind: SymbolKind.Import, node: spec.local ?? spec, scope,
          };
          declare(scope, local, sym);
          symbols.set(local, sym);
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

  return { scopes: [moduleScope], symbols, diagnostics };
}

/** Resolve a name starting in `scope`. */
export function resolveSymbol(scope, name) {
  for (let s = scope; s; s = s.parent) {
    const hit = s.symbols.get(name);
    if (hit) return hit;
  }
  return null;
}
