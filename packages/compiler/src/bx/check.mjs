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

function bxTextValue(children) {
  return (children ?? [])
    .filter((c) => c.type === NodeType.BxText)
    .map((c) => c.value)
    .join('');
}

/**
 * @param {object} ast
 * @param {string} file
 * @param {Map<string, object>} symbols
 * @param {string[]} [stack]
 * @returns {object[]}
 */
export function checkBx(ast, file, symbols, stack = []) {
  const diagnostics = [];
  diagnostics.push(...checkSlots(ast, file));

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
    const hasElementChildren = (el.children ?? []).some((c) => c.type === NodeType.BxElement || c.type === NodeType.BxFragment);
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
    } else if (textChild && !childrenProp && textChild.trim()) {
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

  walk(ast, (n) => {
    if (n.type === NodeType.BxElement || n.type === NodeType.BxFragment) checkElement(n);
  });

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
