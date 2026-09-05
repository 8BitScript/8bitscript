// Template layout: `text.print(cell, \`TICK ${ticks % 10:1} OPTION ${option}\`)`
// split into the pieces a person would have written by hand — one run of
// text and one number field at a time, each at the cell the pieces before
// it add up to.
//
// One implementation, two callers. The checker (packages/compiler/src/
// checker) runs it so a template's shape and field-width problems reach
// the editor — `analyze()` never lowers, and the editor only sees what
// `analyze()` reports. Lowering (packages/compiler/src/ir) runs it again
// to build the calls, and refuses on the same problems so a direct
// `lower()` can never silently drop a template. The linker deduplicates
// the two reports of one problem by code and span.
//
// What both need to know about names, without a binder: the types of the
// current module's own globals and functions (scanDeclaredTypes) and of
// the enclosing function's parameters. That is enough to size a field from
// its expression — `utinyint` is three digits, `usmallint` five — and
// honest about the rest: an imported name, a namespace member, or a call
// across modules has no visible type, and such a field needs its width
// written (`${x:3}`) rather than guessed.
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { NodeType } from '../ast/index.mjs';
import { resolveIntegerType } from '../types/index.mjs';

/** A string holds at most this many characters (one length byte). */
export const MAX_STRING_LENGTH = 255;

/** `void` / `bool` / `string` / an integer type, or null when `name` is none of them. */
export function resolveScalarType(name, { allowVoid = false, allowString = false } = {}) {
  if (name === 'void') return allowVoid ? 'void' : null;
  if (name === 'string') return allowString ? 'string' : null;
  if (name === 'bool') return 'bool';
  const resolved = resolveIntegerType(name);
  return resolved ? resolved.canonicalName : null;
}

/** Elements an array may hold at most: an index has to fit the machine's address arithmetic. */
export const MAX_ARRAY_LENGTH = 65535;

/**
 * `array<T, N>` resolved: the element type and the length, or a reason it
 * cannot be. `N` is a literal or a const in `consts` (name to value) — a
 * const is resolved by 8bitscript, so it can size a type as well as a
 * literal can.
 *
 * @returns {{ type: string, length: number } | { error: string }}
 */
export function resolveArrayType(annotation, consts = new Map()) {
  const [element, size] = annotation?.typeArguments ?? [];
  const type = element?.name && resolveScalarType(element.name);
  if (!element || !type || element.typeArguments?.length) {
    return { error: 'array<T, N> needs an integer or bool element type T' };
  }
  let length = null;
  if (size?.type === NodeType.IntegerLiteral) length = size.value;
  else if (size?.type === NodeType.TypeReference && !size.typeArguments?.length && consts.has(size.name)) {
    length = consts.get(size.name);
  }
  if (length === null) {
    return { error: 'array<T, N> needs a length N: an integer literal, or a const declared in this module' };
  }
  if (!Number.isInteger(length) || length < 1 || length > MAX_ARRAY_LENGTH) {
    return { error: `an array length must be 1..${MAX_ARRAY_LENGTH}, not ${length}` };
  }
  return { type, length };
}

/** The type a `.length` folds to: the smallest unsigned type the number fits. */
export function typeForCount(n) {
  return n <= 255 ? 'utinyint' : 'usmallint';
}

/** Decimal digits the widest value of an unsigned type needs: 255 -> 3, 65535 -> 5. */
export function digitsFor(typeName) {
  const type = resolveIntegerType(typeName);
  if (!type || type.signed || type.bits > 16) return null;
  return String(type.max).length;
}

/** Widest of two integer types, for the result of arithmetic on them. */
function widerOf(a, b) {
  const ta = resolveIntegerType(a);
  const tb = resolveIntegerType(b);
  if (!ta || !tb) return null;
  return ta.bits >= tb.bits ? ta.canonicalName : tb.canonicalName;
}

const COMPARISON_OPERATORS = new Set(['==', '!=', '<', '>', '<=', '>=', '&&', '||']);

/**
 * The declared types of a module's top-level globals, consts, and
 * functions (return types), keyed by name — what a field expression's
 * type can be read from without a binder. Arrays are listed apart, with
 * their element type, length, and whether they are `const` (data in the
 * program) or `let` (RAM): `a[i]` has the element type, `a.length` is a
 * number, and `a` on its own is neither.
 *
 * @returns {{ globalTypes: Map<string,string>, functionTypes: Map<string,string>,
 *   arrayTypes: Map<string,{ type: string, length: number, constant: boolean }>,
 *   functionArity: Map<string,{ min: number, max: number }> }}
 */
export function scanDeclaredTypes(ast) {
  const globalTypes = new Map();
  const functionTypes = new Map();
  const arrayTypes = new Map();
  // How many arguments each own function takes: `max` is its parameters,
  // `min` those without a default.
  const functionArity = new Map();
  // Literal consts, in source order, so `array<u8, COUNT>` can be sized.
  const consts = new Map();
  for (const node of ast?.body ?? []) {
    if (node.type === NodeType.VariableDeclaration && node.name && node.typeAnnotation) {
      if (node.kind === 'const' && node.initializer?.type === NodeType.IntegerLiteral) {
        consts.set(node.name.name, node.initializer.value);
      }
      if (node.typeAnnotation.name === 'array') {
        const resolved = resolveArrayType(node.typeAnnotation, consts);
        if (!resolved.error) arrayTypes.set(node.name.name, { ...resolved, constant: node.kind === 'const' });
        continue;
      }
      if (node.typeAnnotation.name === 'string') {
        // A string const or a string<N>: `.length` is a byte either way.
        globalTypes.set(node.name.name, 'string');
        continue;
      }
      const type = resolveScalarType(
        node.typeAnnotation.name === 'volatile'
          ? (node.typeAnnotation.typeArguments?.[0]?.name ?? '')
          : node.typeAnnotation.name,
      );
      if (type) globalTypes.set(node.name.name, type);
    }
    if (node.type === NodeType.FunctionDeclaration && node.name) {
      const type = resolveScalarType(node.returnType?.name ?? 'void', { allowVoid: true });
      if (type) functionTypes.set(node.name.name, type);
      const params = node.params ?? [];
      functionArity.set(node.name.name, { max: params.length, min: params.filter((p) => !p.defaultValue).length });
    }
  }
  return { globalTypes, functionTypes, arrayTypes, functionArity };
}

/**
 * The parameter types of a function declaration, keyed by name — the
 * innermost scope a field expression can name.
 */
export function parameterTypes(fn) {
  return new Map((fn.params ?? []).flatMap((p) => {
    const type = p.typeAnnotation?.name && resolveScalarType(p.typeAnnotation.name, { allowString: true });
    return type ? [[p.name.name, type]] : [];
  }));
}

/**
 * The static type of an expression, as far as a module can tell on its
 * own: literals, the enclosing function's parameters, the module's own
 * globals and functions, and arithmetic over those. Null for anything it
 * cannot see.
 *
 * @param {{ paramTypes: Map, globalTypes: Map, functionTypes: Map, arrayTypes?: Map }} scope
 */
export function inferType(node, scope) {
  const arrayOf = (object) => (object?.type === NodeType.Identifier && !scope.paramTypes.has(object.name)
    ? (scope.arrayTypes?.get(object.name) ?? null)
    : null);
  switch (node.type) {
    case NodeType.IntegerLiteral:
      if (node.value <= 255) return 'utinyint';
      if (node.value <= 65535) return 'usmallint';
      return 'uint';
    case NodeType.BooleanLiteral:
      return 'bool';
    case NodeType.Identifier:
      return scope.paramTypes.get(node.name) ?? scope.globalTypes.get(node.name) ?? null;
    case NodeType.BinaryExpression: {
      if (COMPARISON_OPERATORS.has(node.operator)) return 'bool';
      return widerOf(inferType(node.left, scope), inferType(node.right, scope));
    }
    case NodeType.UnaryExpression:
      return node.operator === '!' ? 'bool' : inferType(node.argument, scope);
    case NodeType.IndexExpression:
      return arrayOf(node.object)?.type ?? null;
    case NodeType.MemberExpression: {
      if (node.property?.name !== 'length') return null;
      const array = arrayOf(node.object);
      if (array) return typeForCount(array.length);
      // `s.length` on a string — a parameter, const, or string<N> — is a byte.
      return node.object?.type === NodeType.Identifier && inferType(node.object, scope) === 'string' ? 'utinyint' : null;
    }
    case NodeType.CallExpression:
      return node.callee.type === NodeType.Identifier && !node.callee.compileTime
        ? (scope.functionTypes.get(node.callee.name) ?? null)
        : null;
    default:
      return null;
  }
}

/**
 * Is this call the one shape a template may appear in —
 * `namespace.print(cell, \`...\`)`, exactly two arguments, the second a
 * template? (Whether it is in statement position is the caller's to
 * know: the checker tracks it while walking, lowering only reaches
 * templateCall() from a statement.)
 */
export function isTemplateCall(node) {
  return node?.type === NodeType.CallExpression
    && node.callee?.type === NodeType.MemberExpression
    && node.callee.object?.type === NodeType.Identifier
    && node.callee.property?.name === 'print'
    && node.args.length === 2
    && node.args[1]?.type === NodeType.TemplateLiteral;
}

/** The MISPLACED_TEMPLATE diagnostic for a template anywhere else. */
export function misplacedTemplate(template, file, namespace = null) {
  return diagnostic(
    Codes.MISPLACED_TEMPLATE,
    namespace
      ? `a template string is only valid as the second argument of ${namespace}.print(cell, ...)`
      : "a template string is only valid as the second argument of a namespace's print(cell, ...)",
    file, template.start, template.length,
  );
}

/**
 * Lay a template out. Returns the pieces in order, each with the cell
 * offset it starts at, or the diagnostics that stopped it.
 *
 * @param {object} template  TemplateLiteral node.
 * @param {{ paramTypes: Map, globalTypes: Map, functionTypes: Map }} scope
 * @param {string} file
 * @param {string|null} source  The file's text, so a diagnostic can quote a field back.
 * @returns {{ pieces: ({ kind: 'text', offset: number, node: object }
 *   | { kind: 'field', offset: number, width: number, node: object })[], diagnostics: object[] }}
 */
export function layoutTemplate(template, scope, file, source = null) {
  const pieces = [];
  const diagnostics = [];
  let offset = 0;
  for (const part of template.parts) {
    if (part.type === NodeType.TemplateText) {
      pieces.push({ kind: 'text', offset, node: part });
      offset += part.value.length;
      continue;
    }
    let width;
    if (part.width) {
      width = part.width.value;
      if (width < 1 || width > MAX_STRING_LENGTH) {
        diagnostics.push(diagnostic(
          Codes.UNPRINTABLE_FIELD, `a field width must be 1..${MAX_STRING_LENGTH}, not ${width}`,
          file, part.width.start, part.width.length,
        ));
        continue;
      }
    } else {
      const type = inferType(part.expression, scope);
      width = type ? digitsFor(type) : null;
      if (width === null) {
        const quoted = source
          ? source.slice(part.expression.start, part.expression.start + part.expression.length)
          : '...';
        diagnostics.push(diagnostic(
          Codes.UNPRINTABLE_FIELD,
          type
            ? `a ${type} cannot be a number field: fields show unsigned values up to 16 bits (utinyint, usmallint)`
            : `this field's width cannot be taken from its expression here; say it: \${${quoted}:3}`,
          file, part.start, part.length,
        ));
        continue;
      }
    }
    pieces.push({ kind: 'field', offset, width, node: part });
    offset += width;
  }
  return { pieces, diagnostics };
}
