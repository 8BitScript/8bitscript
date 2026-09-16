// Lower 8BX declarations and elements to ordinary core AST.
//
// A `component Name(props) { body }` becomes a function of the same name,
// in the module that declares it, marked `component: true`. An element
// `<Name a={x} b="y" />` becomes the call `Name(x, "y");` at the place the
// element stood — its children (today: before it) and then the call.
//
// That one decision buys three things the spec asks for (§30, §104, §9):
//
//   hygiene       the body stays in its own module, so every name in it
//                 resolves where the author wrote it, whether the element
//                 is in this file or another;
//   evaluate-once an attribute expression becomes an argument, bound to a
//                 parameter, so `<Foo value={next()} />` runs next() once
//                 however many times Foo's body reads `value`;
//   cross-module  `import { MenuBar } from "./menubar.8bx"` is an ordinary
//                 import of an ordinary exported function, which the
//                 linker already binds and renames.
//
// What it costs is a call — and the linker's inliner pays it back: a
// component function whose arguments are all compile-time values is
// inlined at each site (linker/optimize.mjs), so a static composition
// lowers to the same straight-line code a hand-written program would, and
// only a component fed run-time values stays a real call (§64). The
// backends never see an element; they see functions and calls.
//
// Not yet: `<slot />` (children elaborate before the call, always), named
// slots, spread props, state. Those are the spec's later PRs.
import { NodeType, node } from '../ast/index.mjs';
import { componentOf } from '../binder/index.mjs';

function cloneNode(n) {
  if (!n || typeof n !== 'object') return n;
  if (Array.isArray(n)) return n.map(cloneNode);
  if (typeof n.type !== 'string') return n;
  const copy = { ...n };
  for (const [key, value] of Object.entries(n)) {
    if (Array.isArray(value)) copy[key] = value.map(cloneNode);
    else if (value && typeof value === 'object' && typeof value.type === 'string') copy[key] = cloneNode(value);
  }
  return copy;
}

function bxTextValue(children) {
  return (children ?? [])
    .filter((c) => c.type === NodeType.BxText)
    .map((c) => c.value)
    .join('');
}

/**
 * The arguments of the call an element becomes, one per parameter of the
 * component, in parameter order: the attribute of that name, or the text
 * children for a parameter named `children`, or the parameter's own
 * default when the element left it out (a later argument may still be
 * given, so an omitted middle one is passed explicitly). A bare attribute
 * (`visible`) is `true`.
 */
function argumentsFor(el, sym) {
  const byName = new Map();
  for (const attr of el.attributes ?? []) {
    if (attr.type !== NodeType.BxAttribute) continue;
    byName.set(attr.name, attr.value ?? node(NodeType.BooleanLiteral, attr.start, attr.start + attr.length, { value: true }));
  }
  const text = bxTextValue(el.children);
  const args = [];
  for (const prop of sym.props) {
    if (byName.has(prop.name)) {
      args.push(byName.get(prop.name));
    } else if (prop.name === 'children' && text) {
      args.push(node(NodeType.StringLiteral, el.start, el.start, { value: text.trim() }));
    } else if (prop.defaultValue) {
      args.push(cloneNode(prop.defaultValue));
    } else {
      // Missing and required: the checker reported it. Stop here so the
      // call is still well-formed for whatever comes next.
      break;
    }
  }
  return args;
}

/** `Name(args);` where the element stood, carrying the element's span. */
function callStatement(el, sym) {
  const end = el.start + el.length;
  const callee = node(NodeType.Identifier, el.start, el.start + el.name.length + 1, { name: el.name });
  const call = node(NodeType.CallExpression, el.start, end, { callee, args: argumentsFor(el, sym) });
  return node(NodeType.ExpressionStatement, el.start, end, { expression: call });
}

function elaborateElement(el, symbols) {
  const sym = componentOf(symbols.get(el.name));
  if (!sym) return [];
  const stmts = [];
  for (const child of el.children ?? []) {
    if (child.type === NodeType.BxElement || child.type === NodeType.BxFragment) {
      stmts.push(...elaborateElementTree(child, symbols));
    }
  }
  stmts.push(callStatement(el, sym));
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
 * A component declaration as the function it is: same name, same
 * parameters (typed, with defaults), void, exported if the component was,
 * and `component: true` so the inliner and the size report know what it
 * was. Elements in its body become calls like anywhere else.
 */
function componentFunction(stmt, symbols) {
  const body = stmt.body
    ? node(NodeType.BlockStatement, stmt.body.start, stmt.body.start + stmt.body.length, {
      body: (stmt.body.body ?? []).flatMap((s) => transformStatement(s, symbols)),
    })
    : node(NodeType.BlockStatement, stmt.start, stmt.start + stmt.length, { body: [] });
  return node(NodeType.FunctionDeclaration, stmt.start, stmt.start + stmt.length, {
    name: stmt.name,
    params: stmt.params ?? [],
    returnType: null,
    body,
    exported: stmt.exported ?? false,
    component: true,
  });
}

function transformDecl(stmt, symbols) {
  if (stmt?.type === NodeType.FunctionDeclaration && stmt.body) {
    return {
      ...stmt,
      body: node(NodeType.BlockStatement, stmt.body.start, stmt.body.start + stmt.body.length, {
        body: (stmt.body.body ?? []).flatMap((s) => transformStatement(s, symbols)),
      }),
    };
  }
  if (stmt?.type === NodeType.ComponentDeclaration) {
    return componentFunction(stmt, symbols);
  }
  return stmt;
}

/**
 * @param {object} ast Program node
 * @param {Map<string, object>} symbols the module's bound symbols, imports already linked
 * @returns {object} the same program, with no BX node left in it
 */
export function elaborateBx(ast, symbols) {
  if (!ast || ast.type !== NodeType.Program) return ast;
  ast.body = (ast.body ?? [])
    .map((stmt) => transformDecl(stmt, symbols))
    .flatMap((stmt) => transformStatement(stmt, symbols));
  return ast;
}
