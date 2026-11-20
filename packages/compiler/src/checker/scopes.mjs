// The block-scope store scan shared by the E20 checker rule
// (`immutable.mjs`) and `8bs migrate`'s mutability scan
// (`packages/cli/src/migrate/print.mjs`, `analyzeMutability`). Both must
// agree on what a store reaches, so there is one walk.
//
// Names resolve by BLOCK scope, not per module or function: a block, an `if`
// or `while` branch, a `for` header and its body, and a function (its
// parameters and body) each open a scope, and module-level names (and a
// `mod`'s members) are visible everywhere in the file in any order.
import { NodeType } from '../ast/index.mjs';

const newScope = (parent) => ({ parent, names: new Map() });

export const scopeLookup = (scope, name) => {
  for (let s = scope; s; s = s.parent) {
    const hit = s.names.get(name);
    if (hit) return hit;
  }
  return null;
};

const declareVariable = (scope, decl) => {
  if (decl.name) scope.names.set(decl.name.name, { kind: decl.kind, decl });
};

// Module-level names are visible everywhere in the file, in any order.
const hoist = (scope, body) => {
  for (const s of body ?? []) {
    if (s?.type === NodeType.VariableDeclaration) declareVariable(scope, s);
    else if (s?.type === NodeType.NamespaceDeclaration && s.name) {
      const members = newScope(scope);
      hoist(members, s.members);
      scope.names.set(s.name.name, { kind: 'namespace', members, node: s });
    } else if (s?.name) scope.names.set(s.name.name, { kind: 'other' });
    else if (s?.type === NodeType.ImportDeclaration) {
      for (const spec of s.specifiers) scope.names.set(spec.name, { kind: 'other' });
    }
  }
};

/** The expression a node stores to, or null when it is not a store. */
export const scopeStoreTarget = (n) => {
  if (n.type === NodeType.AssignmentExpression) return n.left;
  if (n.type === NodeType.UpdateExpression) return n.argument;
  return null;
};

/**
 * The declared `let` a store target writes to and the name node to point at,
 * or null. `a[i] = …` writes to `a`; `ns::x = …` to the `let` named `x` in
 * namespace `ns`.
 */
export const scopeTargetOf = (scope, target) => {
  let n = target;
  while (n?.type === NodeType.IndexExpression) n = n.object;
  if (n?.type === NodeType.MemberExpression && n.object.type === NodeType.Identifier) {
    const ns = scopeLookup(scope, n.object.name);
    const member = ns?.kind === 'namespace' ? ns.members.names.get(n.property.name) : null;
    return member?.kind === 'let' ? { decl: member.decl, name: n.property } : null;
  }
  if (n?.type === NodeType.Identifier) {
    const hit = scopeLookup(scope, n.name);
    return hit?.kind === 'let' ? { decl: hit.decl, name: n } : null;
  }
  return null;
};

/**
 * Walk every statement of `ast` with its block scope and call
 * `onExpression(scope, root)` for each expression root.
 *
 * @param {object} ast
 * @param {(scope: object, root: object) => void} onExpression
 * @param {{ skipUpdate?: (forStatement: object) => boolean }} [options]
 *   `skipUpdate` drops a `for` update from the scan when it returns true.
 */
export function walkScopes(ast, onExpression, options = {}) {
  const visitExpression = (scope, root) => {
    if (root) onExpression(scope, root);
  };
  const visitStatements = (scope, body) => {
    for (const s of body ?? []) visitStatement(scope, s);
  };

  function visitFunction(scope, s) {
    const fnScope = newScope(scope);
    for (const p of s.params) fnScope.names.set(p.name.name, { kind: 'param' });
    for (const p of s.params) visitExpression(fnScope, p.defaultValue);
    visitStatement(fnScope, s.body);
  }

  function visitFor(scope, s) {
    const forScope = newScope(scope);
    const { init, update } = s;
    if (init?.type === NodeType.VariableDeclaration) visitStatement(forScope, init);
    else visitExpression(forScope, init);
    visitExpression(forScope, s.test);
    if (!options.skipUpdate?.(s)) visitExpression(forScope, update);
    visitStatement(newScope(forScope), s.body);
  }

  function visitStatement(scope, s) {
    if (!s) return;
    switch (s.type) {
      case NodeType.VariableDeclaration:
      case NodeType.StateDeclaration:
        visitExpression(scope, s.initializer);
        declareVariable(scope, s);
        break;
      case NodeType.FunctionDeclaration:
      case NodeType.ComponentDeclaration:
        visitFunction(scope, s);
        break;
      case NodeType.NamespaceDeclaration: {
        const ns = scopeLookup(scope, s.name?.name);
        const members = ns?.members ?? scope;
        for (const m of s.members) visitStatement(members, m);
        break;
      }
      case NodeType.BlockStatement:
        visitStatements(newScope(scope), s.body);
        break;
      case NodeType.IfStatement:
        visitExpression(scope, s.test);
        visitStatement(newScope(scope), s.consequent);
        visitStatement(newScope(scope), s.alternate);
        break;
      case NodeType.WhileStatement:
        visitExpression(scope, s.test);
        visitStatement(newScope(scope), s.body);
        break;
      case NodeType.ForStatement:
        visitFor(scope, s);
        break;
      case NodeType.ReturnStatement:
        visitExpression(scope, s.argument);
        break;
      case NodeType.ExpressionStatement:
        visitExpression(scope, s.expression);
        break;
      case NodeType.BxElement:
      case NodeType.BxFragment:
        visitExpression(scope, s);
        break;
      default:
        break;
    }
  }

  const moduleScope = newScope(null);
  hoist(moduleScope, ast.body);
  visitStatements(moduleScope, ast.body);
}
