// The checker.
//
// Four rules so far: an integer literal has to fit the type it is assigned
// to; the runtime builtin's name — `waitFrame` (packages/compiler/src/ir)
// — is reserved; a string that becomes program data (a literal, or the
// text of a template) holds only the portable character set, at most 255
// of them; a template string sits where the compiler can lay it out
// (`namespace.print(cell, \`...\`)` as a statement) with every field
// sized — the same layout lowering performs (packages/compiler/src/
// templates), run here so its diagnostics reach the editor; and a
// top-level `const` — a compile-time constant with no storage — is never
// assigned to.
//
// This used to pattern-match a fixed token shape because there was no tree to
// walk. It now runs on the AST, which is what the parser bought: the rule finds
// declarations anywhere — inside a function body, inside a `for` initializer,
// on an exported declaration — rather than only at the one shape a token scan
// could recognize. The diagnostic code, the message, and the span are
// unchanged, because a rule moving to a better home should not look different
// to the person reading the error.
//
// Still deliberately narrow: the initializer must be a literal, optionally
// negated. `let x: u8 = 200 + 100` is not folded, because constant folding
// belongs after a binder that knows what names mean.
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { NodeType, walk } from '../ast/index.mjs';
import { resolveIntegerType } from '../types/index.mjs';
import {
  scanDeclaredTypes, parameterTypes, layoutTemplate, isTemplateCall, misplacedTemplate, resolveScalarType,
} from '../templates/index.mjs';

// The one runtime builtin that is a bare name: `waitFrame()` lowers to its
// own IR kind that every backend emits in its own way
// (packages/compiler/src/ir). It is closer to a keyword than to an ordinary
// name, but implemented as a reserved identifier rather than a grammar
// keyword — a call's *shape* is an ordinary call, and keywords are not
// valid callees. Reserving the name here is what keeps a user's own
// `waitFrame` from being silently reinterpreted as the builtin instead of
// getting a clear diagnostic.
//
// Compile-time functions (`#frames(...)`, packages/compiler/src/fold) need
// no reservation: their `#` spelling is its own token, so `let frames`
// never collides. Nor does the unit word (`seconds` in
// `#frames(0.5, seconds)`): that argument slot can never hold a variable,
// so the fold recognizes the word by spelling in place and
// `let seconds: uint` anywhere else stays an ordinary declaration.
const RESERVED_BUILTIN_NAMES = new Map([
  ['waitFrame', 'the built-in frame wait, waitFrame()'],
]);

// What every target's character set can show: the Commodore machines hold
// both cases at once in their own text character set (measured directly
// against the PET's ROM, packages/pet/src/text.8bs's own header — the
// "Commodore machines are switched to their upper-case set" premise this
// rule used to rest on was wrong, or at least stale, for at least the
// PET). The NES ships its own font (packages/nes/native/6502/font.s) with
// no lower-case glyphs drawn yet ("37 blank tiles (no lower-case yet)",
// that file's own comment) — a real, currently-true gap, not enforced
// here any more now that lower case is allowed: NES is a parked target
// this release does not build for (RELEASE_MACHINES), and the checker
// runs target-blind (one AST pass, not per-machine), so it has no way to
// refuse lower case only for NES without refusing it everywhere. When NES
// returns, its own font needs the missing glyphs before a lower-case
// screen string reaches it — this is where to look, not a checker rule to
// re-add blindly. Import specifiers are StringLiteral nodes too and are
// skipped: a module path is not screen text.
const PORTABLE_CHARACTERS = /^[ 0-9A-Za-z!,\-.:?]*$/;
const MAX_STRING_LENGTH = 255;

function checkScreenText(n, file, diagnostics) {
  if (n.unterminated) return; // the lexer reported it; whatever follows the quote is not the text
  const value = n.value ?? '';
  if (!PORTABLE_CHARACTERS.test(value)) {
    const bad = [...value].find((ch) => !PORTABLE_CHARACTERS.test(ch));
    diagnostics.push(diagnostic(
      Codes.UNPORTABLE_CHARACTER,
      `'${bad}' is not in the portable character set (space, 0-9, A-Z, a-z, and ! , - . : ?)`,
      file, n.start, n.length,
    ));
    return;
  }
  if (value.length > MAX_STRING_LENGTH) {
    diagnostics.push(diagnostic(
      Codes.STRING_TOO_LONG,
      `a string holds at most ${MAX_STRING_LENGTH} characters; this one is ${value.length}`,
      file, n.start, n.length,
    ));
  }
}

function reservedNameDiagnostic(nameNode, file) {
  return diagnostic(
    Codes.RESERVED_BUILTIN_NAME,
    `'${nameNode.name}' is reserved for ${RESERVED_BUILTIN_NAMES.get(nameNode.name)}`,
    file, nameNode.start, nameNode.length,
  );
}

/**
 * The constant value of an initializer, or null when it is not a plain literal.
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

// A const is UPPER_SNAKE; a variable starts with a lower-case letter. The
// spelling is the compile-time signal: `LIMIT` is resolved by 8bitscript,
// `limit` is storage on the machine. Namespace members count — `const`
// inside `namespace BorderColor` is `BLUE` — and so does a local.
const CONST_NAME = /^[A-Z][A-Z0-9_]*$/;
const VARIABLE_NAME = /^[a-z_]/;

/** `OptionCount` -> `OPTION_COUNT`, `borders` -> `BORDERS`: the spelling a const should have. */
function constSpelling(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

function checkNameCase(n, file, diagnostics) {
  const name = n.name.name;
  if (n.kind === 'const' && !CONST_NAME.test(name)) {
    diagnostics.push(diagnostic(
      Codes.NAME_CASE,
      `a const is written in upper case, so a reader knows it is resolved by 8bitscript: ${constSpelling(name)}`,
      file, n.name.start, n.name.length,
    ));
  } else if (n.kind === 'let' && !VARIABLE_NAME.test(name)) {
    diagnostics.push(diagnostic(
      Codes.NAME_CASE,
      `a variable starts with a lower-case letter; an upper-case name is a const`,
      file, n.name.start, n.name.length,
    ));
  }
}

/**
 * The rules that need a function's scope. Templates: each one must be the
 * second argument of a `namespace.print` call in statement position, and
 * each of its fields must have a width the layout can determine — a field
 * expression is typed in the scope of the parameters around it, and a
 * template outside any function (a global initializer) has nowhere to be
 * laid out at all. Consts: this module's top-level `const`s are never
 * assigned to or `++`/`--`ed, unless a parameter of the same name shadows
 * one, which is ordinary lexical scoping.
 */
function checkFunctions(ast, file, source, diagnostics) {
  const declared = scanDeclaredTypes(ast);
  const consts = new Set(ast.body
    .filter((n) => n.type === NodeType.VariableDeclaration && n.kind === 'const' && n.name)
    .map((n) => n.name.name));
  const constArrays = new Set([...declared.arrayTypes].filter(([, a]) => a.constant).map(([name]) => name));
  // `HALF = 2` on a const, or `Table[0] = 2` on a const array (whose
  // elements are data in the program). Either way the name is the span.
  const assignedConst = (target, params) => {
    const name = target?.type === NodeType.IndexExpression ? target.object : target;
    if (name?.type !== NodeType.Identifier || params.has(name.name)) return null;
    if (target.type === NodeType.IndexExpression) return constArrays.has(name.name) ? name : null;
    return consts.has(name.name) ? name : null;
  };
  const visitFunction = (fn) => {
    if (!fn.body) return; // a function whose body is still being typed
    // Locals count with parameters here — function-scoped, an approximation
    // of the block scoping lowering applies, enough to know a name is not
    // the const or array it shadows and what type a field of it has.
    const paramTypes = parameterTypes(fn);
    walk(fn.body, (n) => {
      if (n.type !== NodeType.VariableDeclaration || !n.name || n.kind !== 'let') return;
      const type = n.typeAnnotation?.name && resolveScalarType(n.typeAnnotation.name);
      if (type && !n.typeAnnotation.typeArguments?.length) paramTypes.set(n.name.name, type);
    });
    const scope = { ...declared, paramTypes };
    // Parents are visited before children, so a template reached through
    // its statement is claimed here before walk() descends to it.
    const placed = new Set();
    walk(fn.body, (n) => {
      if (n.type === NodeType.ExpressionStatement && isTemplateCall(n.expression)) {
        const template = n.expression.args[1];
        placed.add(template);
        diagnostics.push(...layoutTemplate(template, scope, file, source).diagnostics);
        return;
      }
      if (n.type === NodeType.TemplateLiteral && !placed.has(n)) {
        diagnostics.push(misplacedTemplate(n, file));
        return;
      }
      const target = n.type === NodeType.AssignmentExpression ? n.left
        : n.type === NodeType.UpdateExpression ? n.argument : null;
      const name = target && assignedConst(target, paramTypes);
      if (name) {
        diagnostics.push(diagnostic(
          Codes.ASSIGN_TO_CONST,
          target.type === NodeType.IndexExpression
            ? `'${name.name}' is a const array — data in the program, not RAM — and cannot be assigned to`
            : `'${name.name}' is a const — a compile-time value with no storage — and cannot be assigned`,
          file, name.start, name.length,
        ));
      }
    });
  };
  for (const node of ast.body) {
    if (node.type === NodeType.FunctionDeclaration) visitFunction(node);
    if (node.type === NodeType.NamespaceDeclaration) {
      for (const member of node.members ?? []) {
        if (member?.type === NodeType.FunctionDeclaration) visitFunction(member);
      }
    }
    if (node.type === NodeType.VariableDeclaration) {
      walk(node.initializer, (n) => {
        if (n.type === NodeType.TemplateLiteral) diagnostics.push(misplacedTemplate(n, file));
      });
    }
  }
}

/**
 * @param {object} ast   Program node from the parser.
 * @param {string} file
 * @param {string|null} [source]  The file's text, so a diagnostic can quote code back.
 * @returns {object[]} diagnostics
 */
export function check(ast, file = '<unknown>', source = null) {
  const diagnostics = [];
  if (!ast) return diagnostics;

  checkFunctions(ast, file, source, diagnostics);

  walk(ast, (n, parent) => {
    if (
      (n.type === NodeType.StringLiteral && parent?.type !== NodeType.ImportDeclaration)
      || n.type === NodeType.TemplateText
    ) {
      checkScreenText(n, file, diagnostics);
      return;
    }

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
    if (n.name) checkNameCase(n, file, diagnostics);

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
