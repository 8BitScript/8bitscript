// Semantic checks for 8BX elements against component signatures from the binder.
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { NodeType, walk } from '../ast/index.mjs';
import { SymbolKind } from '../binder/index.mjs';

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

  const checkElement = (el) => {
    if (!el || (el.type !== NodeType.BxElement && el.type !== NodeType.BxFragment)) return;
    if (el.type === NodeType.BxFragment) {
      for (const child of el.children ?? []) checkElement(child);
      return;
    }
    const sym = symbols.get(el.name);
    if (!sym || sym.kind !== SymbolKind.Component) {
      diagnostics.push(diagnostic(
        Codes.BX_UNKNOWN_COMPONENT,
        `unknown component '${el.name}'`,
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
