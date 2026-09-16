// Lower 8BX element trees to ordinary core AST (stateless components inline).
import { NodeType, node, walk } from '../ast/index.mjs';
import { SymbolKind } from '../binder/index.mjs';

function cloneNode(n) {
  if (!n || typeof n !== 'object') return n;
  if (typeof n.type !== 'string') return n;
  const copy = { ...n };
  for (const [key, value] of Object.entries(n)) {
    if (Array.isArray(value)) {
      copy[key] = value.map((item) => (item && typeof item.type === 'string' ? cloneNode(item) : item));
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      copy[key] = cloneNode(value);
    }
  }
  return copy;
}

function substituteName(tree, name, replacement) {
  walk(tree, (n, parent) => {
    if (n.type === NodeType.Identifier && n.name === name && parent?.type !== NodeType.BxAttribute) {
      Object.assign(n, cloneNode(replacement));
    }
  });
}

function bxTextValue(children) {
  return (children ?? [])
    .filter((c) => c.type === NodeType.BxText)
    .map((c) => c.value)
    .join('');
}

function propBindings(el, sym) {
  const bindings = new Map();
  const text = bxTextValue(el.children);
  if (text && sym.props.some((p) => p.name === 'children')) {
    const lit = node(NodeType.StringLiteral, el.start, el.start, { value: text.trim() });
    bindings.set('children', lit);
  }
  for (const attr of el.attributes ?? []) {
    if (attr.type === NodeType.BxAttribute && attr.value) {
      bindings.set(attr.name, attr.value);
    }
  }
  for (const prop of sym.props) {
    if (!bindings.has(prop.name) && prop.defaultValue) {
      bindings.set(prop.name, cloneNode(prop.defaultValue));
    }
  }
  return bindings;
}

function elaborateElement(el, symbols) {
  const sym = symbols.get(el.name);
  if (!sym || sym.kind !== SymbolKind.Component) return [];
  const bindings = propBindings(el, sym);
  const temps = [];
  const body = cloneNode(sym.body);
  for (const [param, expr] of bindings) {
    substituteName(body, param, expr);
  }
  const stmts = [];
  for (const child of el.children ?? []) {
    if (child.type === NodeType.BxElement || child.type === NodeType.BxFragment) {
      stmts.push(...elaborateElementTree(child, symbols));
    }
  }
  stmts.push(...(body.body ?? []));
  return stmts;
}

function elaborateElementTree(n, symbols) {
  if (n.type === NodeType.BxFragment) {
    return (n.children ?? []).flatMap((c) => elaborateElementTree(c, symbols));
  }
  if (n.type === NodeType.BxElement) {
    return elaborateElement(n, symbols);
  }
  return [];
}

function transformStatement(stmt, symbols) {
  if (!stmt) return [stmt];
  if (stmt.type === NodeType.BxElement || stmt.type === NodeType.BxFragment) {
    return elaborateElementTree(stmt, symbols);
  }
  if (stmt.type === NodeType.BlockStatement) {
    return [node(NodeType.BlockStatement, stmt.start, stmt.start + stmt.length, {
      body: (stmt.body ?? []).flatMap((s) => transformStatement(s, symbols)),
    })];
  }
  if (stmt.type === NodeType.IfStatement) {
    return [node(NodeType.IfStatement, stmt.start, stmt.start + stmt.length, {
      test: stmt.test,
      consequent: transformStatement(stmt.consequent, symbols)[0],
      alternate: stmt.alternate ? transformStatement(stmt.alternate, symbols)[0] : null,
    })];
  }
  if (stmt.type === NodeType.WhileStatement) {
    return [node(NodeType.WhileStatement, stmt.start, stmt.start + stmt.length, {
      test: stmt.test,
      body: transformStatement(stmt.body, symbols)[0],
    })];
  }
  if (stmt.type === NodeType.ForStatement) {
    return [node(NodeType.ForStatement, stmt.start, stmt.start + stmt.length, {
      init: stmt.init,
      test: stmt.test,
      update: stmt.update,
      body: transformStatement(stmt.body, symbols)[0],
    })];
  }
  return [stmt];
}

/**
 * @param {object} ast Program node
 * @param {Map<string, object>} symbols
 * @returns {object} mutated program
 */
function transformDecl(stmt, symbols) {
  if (stmt?.type === NodeType.FunctionDeclaration && stmt.body) {
    return {
      ...stmt,
      body: node(NodeType.BlockStatement, stmt.body.start, stmt.body.start + stmt.body.length, {
        body: (stmt.body.body ?? []).flatMap((s) => transformStatement(s, symbols)),
      }),
    };
  }
  if (stmt?.type === NodeType.ComponentDeclaration && stmt.body) {
    return {
      ...stmt,
      body: node(NodeType.BlockStatement, stmt.body.start, stmt.body.start + stmt.body.length, {
        body: (stmt.body.body ?? []).flatMap((s) => transformStatement(s, symbols)),
      }),
    };
  }
  return stmt;
}

export function elaborateBx(ast, symbols) {
  if (!ast || ast.type !== NodeType.Program) return ast;
  ast.body = (ast.body ?? [])
    .map((stmt) => transformDecl(stmt, symbols))
    .flatMap((stmt) => transformStatement(stmt, symbols));
  // Drop component declarations — they are compile-time only.
  ast.body = ast.body.filter((s) => s.type !== NodeType.ComponentDeclaration);
  return ast;
}
