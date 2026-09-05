// The checker.
//
// Two rules so far: an integer literal has to fit the type it is assigned
// to, and the builtins' names — `seconds` and its clocks such as `FRAMES`
// (packages/compiler/src/fold) and `waitFrame` (packages/compiler/src/ir) —
// are reserved.
//
// This used to pattern-match a fixed token shape because there was no tree to
// walk. It now runs on the AST, which is what the parser bought: the rule finds
// declarations anywhere — inside a function body, inside a `for` initialiser,
// on an exported declaration — rather than only at the one shape a token scan
// could recognise. The diagnostic code, the message, and the span are
// unchanged, because a rule moving to a better home should not look different
// to the person reading the error.
//
// Still deliberately narrow: the initialiser must be a literal, optionally
// negated. `let x: u8 = 200 + 100` is not folded, because constant folding
// belongs after a binder that knows what names mean.
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { NodeType, walk } from '../ast/index.mjs';
import { resolveIntegerType } from '../types/index.mjs';
import { DURATION_CLOCKS } from '../fold/index.mjs';

// The language's builtins, none of which is imported from @8bitscript/screen
// or declared anywhere a binder could find: `seconds(...)` is a pure
// compile-time fold (packages/compiler/src/fold) and the clock names it
// accepts as a second argument (`FRAMES`) are consumed by that same fold,
// `waitFrame()` lowers to its own IR kind that every backend emits in its
// own way (packages/compiler/src/ir). All are closer to keywords than to
// ordinary names, but implemented as reserved identifiers rather than
// grammar keywords — a call's *shape* is an ordinary call, and keywords are
// not valid callees or arguments. Reserving the names here is what keeps a
// user's own `seconds`/`FRAMES`/`waitFrame` from being silently
// reinterpreted as the builtin instead of getting a clear diagnostic.
const RESERVED_BUILTIN_NAMES = new Map([
  ['seconds', 'the built-in duration constructor, seconds(...)'],
  ...[...DURATION_CLOCKS.keys()].map((name) => [
    name, `the built-in duration clock, seconds(..., ${name})`,
  ]),
  ['waitFrame', 'the built-in frame wait, waitFrame()'],
]);

function reservedNameDiagnostic(nameNode, file) {
  return diagnostic(
    Codes.RESERVED_BUILTIN_NAME,
    `'${nameNode.name}' is reserved for ${RESERVED_BUILTIN_NAMES.get(nameNode.name)}`,
    file, nameNode.start, nameNode.length,
  );
}

/**
 * The constant value of an initialiser, or null when it is not a plain literal.
 *
 * @returns {{ value: number, node: object } | null}
 */
function literalValue(expression) {
  if (!expression) return null;
  if (expression.type === NodeType.IntegerLiteral) {
    return { value: expression.value, node: expression };
  }
  if (
    expression.type === NodeType.UnaryExpression &&
    (expression.operator === '-' || expression.operator === '+') &&
    expression.argument?.type === NodeType.IntegerLiteral
  ) {
    const magnitude = expression.argument.value;
    return {
      value: expression.operator === '-' ? -magnitude : magnitude,
      node: expression,
    };
  }
  return null;
}

/**
 * @param {object} ast   Program node from the parser.
 * @param {string} file
 * @returns {object[]} diagnostics
 */
export function check(ast, file = '<unknown>') {
  const diagnostics = [];
  if (!ast) return diagnostics;

  walk(ast, (n) => {
    if (n.type === NodeType.ImportDeclaration) {
      for (const specifier of n.specifiers) {
        if (RESERVED_BUILTIN_NAMES.has(specifier.name)) {
          diagnostics.push(reservedNameDiagnostic(specifier, file));
        }
      }
      return;
    }

    if (n.type === NodeType.FunctionDeclaration || n.type === NodeType.Parameter) {
      if (n.name && RESERVED_BUILTIN_NAMES.has(n.name.name)) {
        diagnostics.push(reservedNameDiagnostic(n.name, file));
      }
      return;
    }

    if (n.type !== NodeType.VariableDeclaration) return;

    if (n.name && RESERVED_BUILTIN_NAMES.has(n.name.name)) {
      diagnostics.push(reservedNameDiagnostic(n.name, file));
    }

    const typeName = n.typeAnnotation?.name;
    // A type constructor such as ptr<u8> has type arguments and is not itself
    // an integer, so it never resolves against the registry below.
    if (n.typeAnnotation?.typeArguments?.length) return;
    const resolved = typeName && resolveIntegerType(typeName);
    if (!resolved) return;

    const literal = literalValue(n.initializer);
    if (!literal) return;

    // The message keeps whatever the programmer actually wrote (`u8` or
    // `utinyint`) even though both resolve to the same type: a diagnostic
    // should point at the reader's own words, not a canonicalised rewrite.
    const { min, max } = resolved;
    if (literal.value < min || literal.value > max) {
      diagnostics.push(
        diagnostic(
          Codes.VALUE_OUT_OF_RANGE,
          `${literal.value} does not fit in ${typeName} (${min}..${max})`,
          file,
          literal.node.start,
          literal.node.length,
        ),
      );
    }
  });

  return diagnostics;
}
