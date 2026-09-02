// The checker.
//
// One rule so far: an integer literal has to fit the type it is assigned to.
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
    if (n.type !== NodeType.VariableDeclaration) return;

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
