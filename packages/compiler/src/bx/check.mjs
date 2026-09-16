// Semantic checks for 8BX elements against component signatures from the binder.
//
// An element names a component declared in this module or imported from
// another. The imported case is answered by the binder's cross-module
// step (bindImportedComponents); when that step has not run — analyze()
// without import resolution — an imported name used as an element is
// valid but unknown, the same way a `.<machine>.8bs` import is valid but
// target-dependent, and nothing is reported for it.
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { NodeType, walk } from '../ast/index.mjs';
import { SymbolKind, componentOf } from '../binder/index.mjs';

/** The element's text children, already normalized by the parser (§35), as one string. */
function bxTextValue(children) {
  return (children ?? [])
    .filter((c) => c.type === NodeType.BxText)
    .map((c) => c.value)
    .join(' ');
}

/**
 * @param {object} ast
 * @param {string} file
 * @param {Map<string, object>} symbols
 * @param {string[]} [stack]
 * @returns {object[]}
 */
export function checkBx(ast, file, symbols, { sourceKind = '.8bs', strict = true } = {}, stack = []) {
  const diagnostics = [];
  diagnostics.push(...checkSlots(ast, file));
  diagnostics.push(...checkState(ast, file));
  diagnostics.push(...checkMethods(ast, file));
  if (sourceKind === '.8bx') diagnostics.push(...checkFileRole(ast, file, strict));

  const checkElement = (el) => {
    if (!el || (el.type !== NodeType.BxElement && el.type !== NodeType.BxFragment)) return;
    if (el.type === NodeType.BxFragment) {
      for (const child of el.children ?? []) checkElement(child);
      return;
    }
    // The one intrinsic: where a component's children go. Its placement
    // is checkSlots' business; it is never a component.
    if (el.name === 'slot') return;
    const named = symbols.get(el.name);
    const sym = componentOf(named);
    if (!sym) {
      // An import whose module was never looked at cannot be judged; an
      // import that was looked at and is not an exported component can.
      if (named?.kind === SymbolKind.Import && !named.resolved) return;
      diagnostics.push(diagnostic(
        Codes.BX_UNKNOWN_COMPONENT,
        named?.kind === SymbolKind.Import
          ? `'${el.name}' is imported from '${named.source}', which does not export a component by that name`
          : `unknown component '${el.name}'`,
        file, el.start, el.length,
      ));
      return;
    }
    if (stack.includes(el.name)) {
      diagnostics.push(diagnostic(
        Codes.BX_COMPONENT_RECURSION,
        `component '${el.name}' appears in its own tree`,
        file, el.start, el.length,
      ));
      return;
    }
    const nextStack = [...stack, el.name];
    const textChild = bxTextValue(el.children);
    const hasElementChildren = (el.children ?? []).some((c) => c.type === NodeType.BxElement || c.type === NodeType.BxFragment
      || (c.type === NodeType.BxExpressionChild && c.expression));
    if (hasElementChildren && !sym.allowsChildren) {
      diagnostics.push(diagnostic(
        Codes.BX_CHILDREN_REJECTED,
        `component '${el.name}' does not accept element children`,
        file, el.start, el.length,
      ));
    }
    const seen = new Set();
    for (const attr of el.attributes ?? []) {
      if (attr.type === NodeType.BxSpreadAttribute) continue;
      if (seen.has(attr.name)) {
        diagnostics.push(diagnostic(
          Codes.BX_DUPLICATE_PROP,
          `duplicate prop '${attr.name}' on <${el.name}>`,
          file, attr.start, attr.length,
        ));
      }
      seen.add(attr.name);
      const prop = sym.props.find((p) => p.name === attr.name);
      if (!prop) {
        diagnostics.push(diagnostic(
          Codes.BX_UNKNOWN_PROP,
          `component '${el.name}' has no prop '${attr.name}'`,
          file, attr.start, attr.length,
        ));
      }
    }
    const childrenProp = sym.props.find((p) => p.name === 'children');
    if (textChild && childrenProp) {
      seen.add('children');
    } else if (textChild && !childrenProp) {
      diagnostics.push(diagnostic(
        Codes.BX_CHILDREN_REJECTED,
        `component '${el.name}' does not accept text children`,
        file, el.start, el.length,
      ));
    }
    for (const prop of sym.props) {
      if (prop.name === 'children') {
        if (!textChild && !hasElementChildren && !prop.optional && prop.defaultValue == null) {
          diagnostics.push(diagnostic(
            Codes.BX_MISSING_PROP,
            `<${el.name}> is missing prop '${prop.name}'`,
            file, el.start, el.length,
          ));
        }
        continue;
      }
      const has = seen.has(prop.name) || el.attributes?.some((a) => a.name === prop.name);
      if (!has && !prop.optional && prop.defaultValue == null) {
        diagnostics.push(diagnostic(
          Codes.BX_MISSING_PROP,
          `<${el.name}> is missing prop '${prop.name}'`,
          file, el.start, el.length,
        ));
      }
    }
    for (const child of el.children ?? []) {
      if (child.type === NodeType.BxElement || child.type === NodeType.BxFragment) {
        checkElement(child);
      }
    }
  };

  // Every element once: a child is checked by its parent's recursion, a
  // top-level one and one inside an expression by this walk.
  walk(ast, (n, parent) => {
    const nested = parent?.type === NodeType.BxElement || parent?.type === NodeType.BxFragment;
    if ((n.type === NodeType.BxElement || n.type === NodeType.BxFragment) && !nested) checkElement(n);
  });
  diagnostics.push(...checkComposition(ast, file));

  return diagnostics;
}

/**
 * Where an element may stand (spec §94): as a statement, as a child, or
 * as an arm of `? :` / the right of `&&` in one of those places — a
 * "composition". An element anywhere else is not a value: `let x = <A />`,
 * `f(<A />)`, `a + <A />` are 8BS2024. A `{…}` child that is not a
 * composition — `{score}`, `{f()}` — is 8BS2023: a value between tags is
 * not a child yet (§20 is a later milestone).
 */
function checkComposition(ast, file) {
  const diagnostics = [];
  const isElement = (n) => n?.type === NodeType.BxElement || n?.type === NodeType.BxFragment;
  const isComposition = (n) => {
    if (isElement(n)) return true;
    if (n?.type === NodeType.ConditionalExpression) return isComposition(n.consequent) && isComposition(n.alternate);
    if (n?.type === NodeType.BinaryExpression && n.operator === '&&') return isComposition(n.right);
    return false;
  };
  // `composing` — the node is in a place a composition may stand — flows
  // down only through the arms of a composition-shaped expression.
  const visit = (n, composing) => {
    if (!n || typeof n.type !== 'string') return;
    if (isElement(n)) {
      if (!composing) {
        diagnostics.push(diagnostic(Codes.BX_NOT_A_VALUE, 'a composition is not a value: an element stands as a statement, a child, or an arm of ? : / && there', file, n.start, n.length));
      }
      for (const attr of n.attributes ?? []) visit(attr.value, false);
      for (const child of n.children ?? []) {
        if (child.type === NodeType.BxExpressionChild) {
          if (child.expression && !isComposition(child.expression)) {
            diagnostics.push(diagnostic(Codes.BX_EXPRESSION_CHILD, 'an expression between tags composes: {cond ? <A /> : <B />} or {cond && <A />}; a value there is not a child yet', file, child.start, child.length));
            visit(child.expression, false);
          } else {
            visit(child.expression, true);
          }
        } else {
          visit(child, true);
        }
      }
      return;
    }
    if (n.type === NodeType.ConditionalExpression && composing && isComposition(n)) {
      visit(n.test, false); visit(n.consequent, true); visit(n.alternate, true);
      return;
    }
    if (n.type === NodeType.BinaryExpression && n.operator === '&&' && composing && isComposition(n)) {
      visit(n.left, false); visit(n.right, true);
      return;
    }
    // `return (<…/>)` composes where it stands (§96).
    if (n.type === NodeType.ReturnStatement) { visit(n.argument, composing && isComposition(n.argument)); return; }
    const statementBody = n.type === NodeType.Program || n.type === NodeType.BlockStatement || n.type === NodeType.ComponentDeclaration
      || n.type === NodeType.FunctionDeclaration || n.type === NodeType.IfStatement || n.type === NodeType.WhileStatement || n.type === NodeType.ForStatement;
    for (const [key, value] of Object.entries(n)) {
      if (key === 'type') continue;
      // A statement position: the body/consequent/alternate of a block-like
      // node. Everything else under a node is an expression position.
      const asStatement = statementBody && (key === 'body' || key === 'consequent' || key === 'alternate');
      if (Array.isArray(value)) for (const item of value) visit(item, asStatement);
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value, asStatement);
    }
  };
  visit(ast, true);
  return diagnostics;
}

/**
 * `<slot />` is where a component's children elaborate (spec §33). For
 * the first version it must be exactly one, at the top level of a
 * component's body — not inside `if`/`while`/`for` or a nested block —
 * and no local declared before it may be read after it: the body is
 * split into two functions at the slot (bx/elaborate.mjs), and a local
 * cannot live across that. Anywhere else, or any other way, is 8BS2019.
 */
function checkSlots(ast, file) {
  const diagnostics = [];
  const at = (n, message) => diagnostics.push(diagnostic(Codes.BX_INVALID_SLOT, message, file, n.start, n.length));
  const isSlot = (n) => n?.type === NodeType.BxElement && n.name === 'slot';

  const components = new Set();
  for (const stmt of ast?.body ?? []) {
    if (stmt?.type !== NodeType.ComponentDeclaration) continue;
    components.add(stmt);
    const body = stmt.body?.body ?? [];
    const slots = body.filter(isSlot);
    for (const extra of slots.slice(1)) at(extra, `component '${stmt.name?.name}' places <slot /> more than once; children go in one place`);
    if (slots.length === 0) continue;
    const index = body.indexOf(slots[0]);
    if (slots[0].attributes?.length) at(slots[0], '<slot /> takes no attributes yet (named slots are a later milestone)');
    if ((slots[0].children ?? []).some((c) => c.type !== NodeType.BxText || c.value.trim())) {
      at(slots[0], '<slot /> has no children of its own; it is where the element\'s children go');
    }
    // A local declared before the slot and read after it would live in a
    // different function from its reader.
    const before = new Set(body.slice(0, index)
      .filter((n) => n.type === NodeType.VariableDeclaration && n.name?.name)
      .map((n) => n.name.name));
    if (before.size > 0) {
      for (const later of body.slice(index + 1)) {
        walk(later, (n) => {
          if (n.type === NodeType.Identifier && before.has(n.name)) {
            at(n, `'${n.name}' is declared before <slot /> and used after it; a local cannot cross the slot`);
            before.delete(n.name);
          }
        });
      }
    }
  }
  // Every other <slot /> — nested in control flow inside a component, or
  // anywhere outside one — is out of place.
  const topLevel = new Set([...components].flatMap((c) => (c.body?.body ?? []).filter(isSlot)));
  walk(ast, (n) => {
    if (isSlot(n) && !topLevel.has(n)) {
      at(n, '<slot /> belongs at the top level of a component\'s body, once');
    }
  });
  return diagnostics;
}

/**
 * `.8bs` is code, `.8bx` is composition (spec §2.6). Two tiers:
 *
 *   A, always: `asm6502` has no place in an `.8bx` file. Machine code lives
 *      in a `.8bs` function that the component imports — `8BS2020`.
 *   B, unless the project says `bx: { strict: false }`: a top-level function
 *      whose body holds no element, or a top-level `let`, is ordinary
 *      8BitScript that belongs in an `.8bs` module — `8BS2021`, a warning.
 *      Component methods and `state` are what `.8bx` is for and are not
 *      looked at; neither is anything inside `{…}`, which is ordinary
 *      8BitScript by design.
 */
function checkFileRole(ast, file, strict) {
  const diagnostics = [];
  walk(ast, (n) => {
    if (n.type !== NodeType.AsmBlock) return;
    diagnostics.push(diagnostic(
      Codes.BX_ASM_IN_BX,
      'asm6502 has no place in an .8bx file; put it in a .8bs function and import it',
      file, n.start, n.length,
    ));
  });
  if (!strict) return diagnostics;
  for (const stmt of ast?.body ?? []) {
    // A bare `;` parses to no statement; a declaration whose name the
    // parser could not read has nothing to name here.
    if (!stmt || !stmt.name?.name) continue;
    const { name } = stmt.name;
    if (stmt.type === NodeType.FunctionDeclaration && !hasElement(stmt)) {
      diagnostics.push(diagnostic(
        Codes.BX_ORDINARY_CODE,
        `'${name}' composes nothing: this is ordinary 8BitScript; move it to an .8bs module and import it (or set bx.strict: false)`,
        file, stmt.name.start, stmt.name.length, 'warning',
      ));
    } else if (stmt.type === NodeType.VariableDeclaration && stmt.kind === 'let') {
      diagnostics.push(diagnostic(
        Codes.BX_ORDINARY_CODE,
        `'${name}' is a variable at the top of an .8bx file; state belongs in a component, or in an .8bs module this one imports (or set bx.strict: false)`,
        file, stmt.name.start, stmt.name.length, 'warning',
      ));
    }
  }
  return diagnostics;
}

/** Whether any element or fragment sits anywhere under `node`. */
function hasElement(node) {
  let found = false;
  walk(node, (n) => {
    if (n.type === NodeType.BxElement || n.type === NodeType.BxFragment) found = true;
  });
  return found;
}

/**
 * `state name: type = init;` is per-instance storage (spec §36–§37): one
 * declaration per name, at the top level of a component's body, with a
 * type, and not shadowed by a local or parameter of the same name — the
 * elaborator rewrites every use of the name in the body to the instance's
 * storage, and a shadow would be rewritten too. Anywhere else, `state`
 * means nothing: 8BS2022.
 */
function checkState(ast, file) {
  const diagnostics = [];
  const at = (n, message) => diagnostics.push(diagnostic(Codes.BX_INVALID_STATE, message, file, n.start, n.length));
  const isState = (n) => n?.type === NodeType.StateDeclaration;
  const topLevel = new Set();
  for (const stmt of ast?.body ?? []) {
    if (stmt?.type !== NodeType.ComponentDeclaration) continue;
    const body = stmt.body?.body ?? [];
    const names = new Set(stmt.params?.map((p) => p.name?.name) ?? []);
    const fields = new Set();
    for (const s of body) {
      if (!isState(s)) continue;
      topLevel.add(s);
      const name = s.name?.name;
      if (!name) continue;
      if (!s.typeAnnotation) at(s.name, `state '${name}' needs a type: it is storage the compiler lays out`);
      if (names.has(name)) at(s.name, `state '${name}' has the same name as a prop of '${stmt.name?.name}'`);
      if (fields.has(name)) at(s.name, `state '${name}' is declared twice in '${stmt.name?.name}'`);
      fields.add(name);
    }
    if (fields.size === 0) continue;
    // A local that shadows a field would be rewritten with it.
    walk(stmt.body, (n) => {
      if (n.type === NodeType.VariableDeclaration && n.name?.name && fields.has(n.name.name)) {
        at(n.name, `'${n.name.name}' is state of '${stmt.name?.name}'; a local cannot take its name`);
      }
    });
  }
  walk(ast, (n) => {
    if (isState(n) && !topLevel.has(n)) at(n, 'state belongs at the top level of a component\'s body');
  });
  return diagnostics;
}

/**
 * A method (spec §39) is a function declared at the top level of a
 * component's body. It sees the component's state, not its props: a prop
 * is the element's argument, and a method has no element — so a method
 * that names a prop (and does not declare its own parameter or local of
 * that name) is 8BS2025, with the fix. A method may not take a state
 * field's or another method's name either; those are one namespace.
 */
function checkMethods(ast, file) {
  const diagnostics = [];
  const at = (n, message) => diagnostics.push(diagnostic(Codes.BX_INVALID_METHOD, message, file, n.start, n.length));
  for (const stmt of ast?.body ?? []) {
    if (stmt?.type !== NodeType.ComponentDeclaration) continue;
    const body = stmt.body?.body ?? [];
    const props = new Set((stmt.params ?? []).map((p) => p.name?.name).filter(Boolean));
    const fields = new Set(body.filter((s) => s?.type === NodeType.StateDeclaration).map((s) => s.name?.name).filter(Boolean));
    const seen = new Set();
    for (const m of body) {
      if (m?.type !== NodeType.FunctionDeclaration || !m.name?.name) continue;
      const name = m.name.name;
      if (props.has(name) || fields.has(name)) at(m.name, `method '${name}' takes the name of a prop or state of '${stmt.name?.name}'`);
      if (seen.has(name)) at(m.name, `method '${name}' is declared twice in '${stmt.name?.name}'`);
      seen.add(name);
      // Names the method declares for itself shadow the component's props.
      const own = new Set((m.params ?? []).map((p) => p.name?.name).filter(Boolean));
      walk(m.body, (n) => { if (n.type === NodeType.VariableDeclaration && n.name?.name) own.add(n.name.name); });
      walk(m.body, (n, parent) => {
        const isProperty = parent?.type === NodeType.MemberExpression && parent.property === n;
        const declares = parent?.type === NodeType.VariableDeclaration && parent.name === n;
        if (n.type === NodeType.Identifier && props.has(n.name) && !own.has(n.name) && !isProperty && !declares) {
          at(n, `'${n.name}' is a prop of '${stmt.name?.name}'; a method sees state, not props — pass it as an argument`);
        }
      });
    }
  }
  return diagnostics;
}
