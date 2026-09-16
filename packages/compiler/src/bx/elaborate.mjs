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
// Children go where the component says `<slot />` (§33). A slotted
// component is split at the slot into two functions, `Name__open` (the
// body before it) and `Name__close` (the body after it), and
// `<Name a={x}><A /><B /></Name>` becomes
//
//     Name__open(x); A(); B(); Name__close(x);
//
// — the children run once, in place, between the two halves (§105), and
// every property above still holds: each half stays in its own module,
// and an argument both halves read is hoisted to a local at the call site
// when it could have a side effect, so it is evaluated once (§104). The
// plain `Name` — the whole body with the slot elided — is kept for the
// element with no children and for the `.8bs` call form, which cannot
// pass children (§4.5); reachability pruning drops whichever is unused.
// The checker (bx/check.mjs checkSlots) holds the slot to the shape this
// split can honour: one, at the body's top level, no local across it.
//
// State (§36–§37) is storage per static instance. Inside the component's
// module each `state f: T = v;` becomes one module-level global,
// `__bx_Name__f` — the *template* — and every use of `f` in the body reads
// or writes it. An element then names its instance: the call the element
// becomes carries an `instance` tag, and the linker (specializeInstances)
// clones the function per instance, pointing the clone at its own copy of
// each template global, `__bx_Name__f__i1`, `__i2`, … — the same name in
// every module, because the clones are made on the linked program. Two
// `<Player />` are two functions and two sets of globals; nothing is
// allocated at run time, and the size report shows every byte (§37). The
// halves of a slotted component share one tag, so one instance's state.
//
// Not yet: named slots, spread props, component methods. Those are the
// spec's later PRs.
import { NodeType, node, walk } from '../ast/index.mjs';
import { componentOf } from '../binder/index.mjs';

const isSlot = (n) => n?.type === NodeType.BxElement && n.name === 'slot';
const OPEN = '__open';
const CLOSE = '__close';

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

/** The element's text children, already normalized by the parser (§35), as one string. */
function bxTextValue(children) {
  return (children ?? [])
    .filter((c) => c.type === NodeType.BxText)
    .map((c) => c.value)
    .join(' ');
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
      args.push(node(NodeType.StringLiteral, el.start, el.start, { value: text }));
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

/**
 * `name(args);` where the element stood, carrying the element's span and
 * — when the component keeps state — the element's instance tag, one per
 * element in the module, so the linker can give the call its own storage.
 */
function callStatement(el, name, args, instance) {
  const end = el.start + el.length;
  const callee = node(NodeType.Identifier, el.start, el.start + el.name.length + 1, { name });
  const call = node(NodeType.CallExpression, el.start, end, { callee, args, ...(instance ? { instance } : {}) });
  return node(NodeType.ExpressionStatement, el.start, end, { expression: call });
}

/** The instance tag for one element of a stateful component, or null for a stateless one. */
function instanceTag(el, sym, ctx) {
  if (!sym.state?.length) return null;
  ctx.instances += 1;
  return `${ctx.file}#${ctx.instances}`;
}

/** An argument that may run code: anything but a name or a literal. */
function mayHaveEffect(expr) {
  let effect = false;
  walk(expr, (n) => {
    if (n.type === NodeType.CallExpression || n.type === NodeType.AssignmentExpression
      || n.type === NodeType.UpdateExpression || n.type === NodeType.TemplateLiteral) effect = true;
  });
  return effect;
}

/**
 * An element whose children go into a slot: the two halves around them.
 * An argument both halves would evaluate is bound to a local first when it
 * could do anything, so it does it once. The local is typed as the prop
 * is; a prop with no type cannot be hoisted and is passed as written.
 */
function slottedElement(el, sym, ctx) {
  const args = argumentsFor(el, sym);
  const stmts = [];
  const passed = args.map((arg, i) => {
    const prop = sym.props[i];
    if (!mayHaveEffect(arg) || !prop?.typeAnnotation) return arg;
    ctx.hoisted += 1;
    const name = `__bx_${ctx.hoisted}_${prop.name}`;
    const id = (start) => node(NodeType.Identifier, start, start + name.length, { name });
    stmts.push(node(NodeType.VariableDeclaration, arg.start, arg.start + arg.length, {
      kind: 'let', name: id(arg.start), typeAnnotation: cloneNode(prop.typeAnnotation), initializer: arg, exported: false,
    }));
    return id(arg.start);
  });
  const open = ctx.imported(el.name, sym, OPEN);
  const close = ctx.imported(el.name, sym, CLOSE);
  const instance = instanceTag(el, sym, ctx);
  stmts.push(callStatement(el, open, passed, instance));
  for (const child of el.children ?? []) {
    if (child.type === NodeType.BxElement || child.type === NodeType.BxFragment) {
      stmts.push(...elaborateElementTree(child, ctx));
    }
  }
  stmts.push(callStatement(el, close, passed.map(cloneNode), instance));
  return stmts;
}

function elaborateElement(el, ctx) {
  const sym = componentOf(ctx.symbols.get(el.name));
  if (!sym) return [];
  const elementChildren = (el.children ?? []).some((c) => c.type === NodeType.BxElement || c.type === NodeType.BxFragment);
  if (elementChildren && sym.allowsChildren) return slottedElement(el, sym, ctx);
  // No slot to put children in: the checker said so; they are dropped here
  // rather than run somewhere the component did not ask for them.
  return [callStatement(el, el.name, argumentsFor(el, sym), instanceTag(el, sym, ctx))];
}

function elaborateElementTree(n, ctx) {
  if (n.type === NodeType.BxFragment) {
    return (n.children ?? []).flatMap((c) => elaborateElementTree(c, ctx));
  }
  if (n.type === NodeType.BxElement) {
    return elaborateElement(n, ctx);
  }
  return [];
}

function transformStatement(stmt, ctx) {
  if (!stmt) return [stmt];
  if (stmt.type === NodeType.BxElement || stmt.type === NodeType.BxFragment) {
    return elaborateElementTree(stmt, ctx);
  }
  if (stmt.type === NodeType.BlockStatement) {
    return [node(NodeType.BlockStatement, stmt.start, stmt.start + stmt.length, {
      body: (stmt.body ?? []).flatMap((s) => transformStatement(s, ctx)),
    })];
  }
  if (stmt.type === NodeType.IfStatement) {
    return [node(NodeType.IfStatement, stmt.start, stmt.start + stmt.length, {
      test: stmt.test,
      consequent: transformStatement(stmt.consequent, ctx)[0],
      alternate: stmt.alternate ? transformStatement(stmt.alternate, ctx)[0] : null,
    })];
  }
  if (stmt.type === NodeType.WhileStatement) {
    return [node(NodeType.WhileStatement, stmt.start, stmt.start + stmt.length, {
      test: stmt.test,
      body: transformStatement(stmt.body, ctx)[0],
    })];
  }
  if (stmt.type === NodeType.ForStatement) {
    return [node(NodeType.ForStatement, stmt.start, stmt.start + stmt.length, {
      init: stmt.init,
      test: stmt.test,
      update: stmt.update,
      body: transformStatement(stmt.body, ctx)[0],
    })];
  }
  return [stmt];
}

/**
 * A component declaration as the function(s) it is: same name, same
 * parameters (typed, with defaults), void, exported if the component was,
 * and `component: true` so the inliner and the size report know what it
 * was. Elements in its body become calls like anywhere else. A body with
 * a `<slot />` is also split at it into `Name__open` and `Name__close`.
 */
function componentFunction(stmt, ctx) {
  const declared = stmt.body?.body ?? [];
  const span = stmt.body ?? stmt;
  // State: one template global per field, at module level, and the body
  // reading and writing it by that name.
  const fields = declared.filter((s) => s.type === NodeType.StateDeclaration && s.name?.name);
  const state = fields.map((f) => ({ field: f.name.name, global: `__bx_${stmt.name.name}__${f.name.name}` }));
  const globals = fields.map((f, i) => node(NodeType.VariableDeclaration, f.start, f.start + f.length, {
    kind: 'let',
    name: node(NodeType.Identifier, f.name.start, f.name.start + f.name.length, { name: state[i].global }),
    typeAnnotation: f.typeAnnotation,
    initializer: f.initializer,
    exported: false,
  }));
  const byField = new Map(state.map((s) => [s.field, s.global]));
  const statements = declared.filter((s) => s.type !== NodeType.StateDeclaration).map((s) => {
    if (byField.size === 0) return s;
    const copy = cloneNode(s);
    walk(copy, (n, parent) => {
      // `frame` the name, not `.frame` the member of something else.
      const isProperty = parent?.type === NodeType.MemberExpression && parent.property === n;
      if (n.type === NodeType.Identifier && byField.has(n.name) && !isProperty) n.name = byField.get(n.name);
    });
    return copy;
  });
  const fn = (suffix, body) => node(NodeType.FunctionDeclaration, stmt.start, stmt.start + stmt.length, {
    name: suffix
      ? node(NodeType.Identifier, stmt.name.start, stmt.name.start + stmt.name.length, { name: stmt.name.name + suffix })
      : stmt.name,
    params: suffix ? cloneNode(stmt.params ?? []) : (stmt.params ?? []),
    returnType: null,
    body: node(NodeType.BlockStatement, span.start, span.start + span.length, {
      body: body.flatMap((s) => transformStatement(s, ctx)),
    }),
    exported: stmt.exported ?? false,
    component: true,
    ...(state.length ? { state } : {}),
  });
  const slot = statements.findIndex(isSlot);
  if (slot < 0) return [...globals, fn('', statements)];
  const before = statements.slice(0, slot);
  const after = statements.slice(slot + 1).filter((s) => !isSlot(s));
  return [...globals, fn('', [...before, ...after]), fn(OPEN, before), fn(CLOSE, after)];
}

function transformDecl(stmt, ctx) {
  if (stmt?.type === NodeType.FunctionDeclaration && stmt.body) {
    return [{
      ...stmt,
      body: node(NodeType.BlockStatement, stmt.body.start, stmt.body.start + stmt.body.length, {
        body: (stmt.body.body ?? []).flatMap((s) => transformStatement(s, ctx)),
      }),
    }];
  }
  if (stmt?.type === NodeType.ComponentDeclaration) {
    return componentFunction(stmt, ctx);
  }
  return [stmt];
}

/**
 * @param {object} ast Program node
 * @param {Map<string, object>} symbols the module's bound symbols, imports already linked
 * @param {string} [file] the module's path, for instance tags (§103: identity from source position)
 * @returns {object} the same program, with no BX node left in it
 */
export function elaborateBx(ast, symbols, file = '') {
  if (!ast || ast.type !== NodeType.Program) return ast;
  const ctx = {
    symbols,
    file,
    hoisted: 0,
    instances: 0,
    /**
     * The name a half of a slotted component is called by here. For a
     * component declared in this module that is just `Name__open`; for
     * an imported one the half has to be imported too, so its specifier
     * is added to the import that brought `Name` in — the linker then
     * binds it to the definer's exported function like any other.
     */
    imported(localName, sym, suffix) {
      const half = localName + suffix;
      const named = symbols.get(localName);
      if (named?.kind !== 'Import') return half;
      const decl = (ast.body ?? []).find((s) => s.type === NodeType.ImportDeclaration && s.source?.value === named.source);
      if (decl && !decl.specifiers.some((sp) => sp.name === half)) {
        const spec = decl.specifiers.find((sp) => sp.name === localName) ?? named.node;
        decl.specifiers.push(node(NodeType.Identifier, spec.start, spec.start + spec.length, {
          name: half, imported: (named.imported ?? localName) + suffix,
        }));
      }
      return half;
    },
  };
  ast.body = (ast.body ?? [])
    .flatMap((stmt) => transformDecl(stmt, ctx))
    .flatMap((stmt) => transformStatement(stmt, ctx));
  return ast;
}
