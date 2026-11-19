// E20: assigning to a `let` that is not `let mut` (8BS1031).
//
// The new syntax's parser marks a plain `let` with `immutable: true`; the old
// parser never sets it, so on an old-syntax tree this rule finds nothing.
//
// Names resolve by BLOCK scope, not per module or function: a block, an `if`
// or `while` branch, a `for` header and its body, and a function (its
// parameters and body) each open a scope, and module-level names (and a
// `mod`'s members) are visible everywhere in the file in any order. This is
// the same walk `8bs migrate` uses to decide which `let`s need `mut`
// (`packages/cli/src/migrate/print.mjs`, `analyzeMutability`): a binding the
// converter leaves plain must never be stored to in this checker's eyes, so
// the two scans have to agree on what a store reaches. Keep them in step.
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { NodeType, walk } from '../ast/index.mjs';

const newScope = (parent) => ({ parent, names: new Map() });

const lookup = (scope, name) => {
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
const storeTarget = (n) => {
  if (n.type === NodeType.AssignmentExpression) return n.left;
  if (n.type === NodeType.UpdateExpression) return n.argument;
  return null;
};

/**
 * The declared `let` a store target writes to and the name node to point at,
 * or null. `a[i] = …` writes to `a`; `ns::x = …` to the `let` named `x` in
 * namespace `ns`.
 */
const targetOf = (scope, target) => {
  let n = target;
  while (n?.type === NodeType.IndexExpression) n = n.object;
  if (n?.type === NodeType.MemberExpression && n.object.type === NodeType.Identifier) {
    const ns = lookup(scope, n.object.name);
    const member = ns?.kind === 'namespace' ? ns.members.names.get(n.property.name) : null;
    return member?.kind === 'let' ? { decl: member.decl, name: n.property } : null;
  }
  if (n?.type === NodeType.Identifier) {
    const hit = lookup(scope, n.name);
    return hit?.kind === 'let' ? { decl: hit.decl, name: n } : null;
  }
  return null;
};

/**
 * @param {object} ast   Program node from the parser.
 * @param {string} file
 * @returns {object[]} diagnostics
 */
export function checkImmutableLets(ast, file) {
  const diagnostics = [];
  // A range `for` is a `ForStatement` whose `let i` is immutable and whose
  // update is `i++`: the loop's own step, so it is never reported. `i = 3;`
  // in the body still is.
  const skipped = new Set();

  const visitExpression = (scope, root) => {
    if (!root) return;
    walk(root, (n) => {
      if (skipped.has(n)) return;
      const target = storeTarget(n);
      const hit = target && targetOf(scope, target);
      if (hit?.decl.immutable === true) {
        diagnostics.push(diagnostic(
          Codes.ASSIGN_TO_CONST,
          `'${hit.name.name}' is declared with let, not let mut, and cannot be assigned`,
          file, hit.name.start, hit.name.length,
        ));
      }
    });
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
    if (init?.type === NodeType.VariableDeclaration && init.immutable === true && init.name) {
      const target = update && storeTarget(update);
      if (target?.type === NodeType.Identifier && target.name === init.name.name) skipped.add(update);
    }
    if (init?.type === NodeType.VariableDeclaration) visitStatement(forScope, init);
    else visitExpression(forScope, init);
    visitExpression(forScope, s.test);
    visitExpression(forScope, update);
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
        const ns = lookup(scope, s.name?.name);
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
  return diagnostics;
}
