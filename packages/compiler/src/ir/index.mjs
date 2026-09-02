// The IR, and the lowering from AST to it.
//
// This is the common language between the front end and every backend: the
// 6502 backend and the web backend both consume exactly this, which is what
// keeps them from each re-deriving the language from the AST.
//
// The IR is *structured* — statements contain statements, expressions are
// trees — rather than the linear load/store sketch in the design notes. Both
// current backends want structure (WebAssembly has no goto at all, and C needs
// none for these shapes), so flattening to a linear form today would only mean
// rebuilding the structure in each backend. A linear form earns its place when
// a register allocator does.
//
// THE ONE RULE OF LOWERING: it is exhaustive-with-error. Every AST node either
// has a lowering rule or produces a diagnostic naming the construct. Nothing is
// silently dropped, ever — a program using an uncompilable feature fails with
// a message, not with a .prg missing half its logic.
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { NodeType } from '../ast/index.mjs';
import { resolveIntegerType } from '../types/index.mjs';

/**
 * @typedef {object} IrProgram
 * @property {IrImport[]} imports    Unresolved until the linker consumes them.
 * @property {IrGlobal[]} globals
 * @property {IrFunction[]} functions
 */

/**
 * A parameter or return type: an integer type, `bool`, or (return only) `void`.
 * Kept separate from `global()`'s own inline resolution — a global can never
 * be `void`, so the two checks are similar but not the same rule.
 *
 * @returns {string | null} the canonical type name, or null if not a scalar type
 */
function resolveScalarType(name, { allowVoid = false } = {}) {
  if (name === 'void') return allowVoid ? 'void' : null;
  if (name === 'bool') return 'bool';
  const resolved = resolveIntegerType(name);
  return resolved ? resolved.canonicalName : null;
}

class Lowering {
  constructor(file) {
    this.file = file;
    this.diagnostics = [];
    this.imports = [];
    this.globals = [];
    this.functions = [];
  }

  fail(node, message) {
    this.diagnostics.push(
      diagnostic(Codes.NOT_COMPILABLE, message, this.file, node.start, node.length),
    );
    return null;
  }

  program(ast) {
    for (const node of ast.body) {
      switch (node.type) {
        case NodeType.VariableDeclaration:
          this.global(node);
          break;
        case NodeType.FunctionDeclaration:
          this.function(node);
          break;
        case NodeType.ImportDeclaration:
          this.import(node);
          break;
        default:
          this.fail(node, `a top-level ${node.type} is not compilable yet`);
      }
    }
    return { imports: this.imports, globals: this.globals, functions: this.functions };
  }

  // An import lowers to a record, not to code: the linker resolves it against
  // the other modules in the graph. IR with a non-empty `imports` is not a
  // complete program yet, and both backends refuse it rather than dropping it.
  import(node) {
    if (!node.source) {
      // The parser already reported the malformed import; a lowering record
      // without a source module would be meaningless.
      return this.fail(node, 'an import without a module specifier is not compilable');
    }
    this.imports.push({
      source: node.source.value,
      specifiers: (node.specifiers ?? []).map((spec) => ({
        imported: spec.imported ?? spec.name,
        local: spec.name,
        start: spec.start,
        length: spec.length,
      })),
      start: node.start,
      length: node.length,
    });
  }

  global(node) {
    const annotation = node.typeAnnotation;
    if (!annotation) {
      return this.fail(node, 'a global needs an explicit type to be compilable');
    }

    // Whatever spelling the programmer used — `u8` or `utinyint` — normalises
    // to the same canonical id every backend keys its codegen tables by.
    // `utinyint` and `u8` are one type from here on, never two.
    let type = annotation.name;
    let isVolatile = false;
    let resolved;
    if (type === 'volatile') {
      const inner = annotation.typeArguments?.[0];
      resolved = inner && resolveIntegerType(inner.name);
      if (!resolved) {
        return this.fail(node, 'volatile<T> needs an integer T to be compilable');
      }
      isVolatile = true;
    } else {
      resolved = resolveIntegerType(type);
    }
    if (!resolved && type !== 'bool') {
      return this.fail(node, `a global of type ${annotation.name} is not compilable yet`);
    }
    type = resolved ? resolved.canonicalName : 'bool';

    let address = null;
    for (const decorator of node.decorators ?? []) {
      if (decorator.name === 'address') {
        const argument = decorator.args?.[0];
        if (!argument || argument.type !== NodeType.IntegerLiteral) {
          return this.fail(decorator, '@address needs one integer literal argument');
        }
        address = argument.value;
      } else {
        return this.fail(decorator, `the @${decorator.name} decorator is not compilable yet`);
      }
    }

    let init = null;
    if (node.initializer) {
      init = this.expression(node.initializer);
      if (init && init.kind !== 'const') {
        return this.fail(node.initializer, 'a global initialiser must be a literal to be compilable yet');
      }
    }
    if (address !== null && init) {
      return this.fail(node, 'an @address global maps hardware and cannot have an initialiser');
    }

    this.globals.push({
      name: node.name.name, type, volatile: isVolatile, address,
      init: init ? init.value : 0,
      exported: node.exported ?? false,
    });
  }

  function(node) {
    const params = [];
    for (const p of node.params) {
      const typeName = p.typeAnnotation?.name;
      const type = typeName && resolveScalarType(typeName);
      if (!type || type === 'void') {
        return this.fail(p, `a parameter of type ${typeName ?? '(none)'} is not compilable yet`);
      }
      params.push({ name: p.name.name, type });
    }

    const returnTypeName = node.returnType?.name ?? 'void';
    const returnType = resolveScalarType(returnTypeName, { allowVoid: true });
    if (!returnType) {
      return this.fail(node, `a return type of ${returnTypeName} is not compilable yet`);
    }

    // Threaded through statement lowering so a `return` deep inside an
    // `if`/`while` can be checked against the function it actually belongs
    // to, without passing the type down every recursive call by hand.
    const outerReturnType = this.currentReturnType;
    this.currentReturnType = returnType;
    const body = this.block(node.body);
    this.currentReturnType = outerReturnType;

    this.functions.push({
      name: node.name?.name ?? 'anonymous',
      exported: node.exported,
      params,
      returnType,
      body,
    });
  }

  block(node) {
    const out = [];
    for (const statement of node?.body ?? []) {
      const lowered = this.statement(statement);
      if (lowered) out.push(lowered);
    }
    return out;
  }

  statement(node) {
    switch (node.type) {
      case NodeType.ExpressionStatement: {
        const e = node.expression;
        if (e.type === NodeType.AssignmentExpression) return this.assignment(e);
        if (e.type === NodeType.UpdateExpression) return this.update(e);
        if (e.type === NodeType.CallExpression) return this.callExpression(e);
        return this.fail(node, `a bare ${e.type} statement is not compilable yet`);
      }
      case NodeType.VariableDeclaration:
        return this.fail(node, 'local variables are not compilable yet: globals only for now');
      case NodeType.IfStatement: {
        const test = this.expression(node.test);
        const then = node.consequent ? this.blockOrStatement(node.consequent) : [];
        const otherwise = node.alternate ? this.blockOrStatement(node.alternate) : null;
        return test ? { kind: 'if', test, then, else: otherwise } : null;
      }
      case NodeType.WhileStatement: {
        const test = this.expression(node.test);
        const body = this.blockOrStatement(node.body);
        return test ? { kind: 'while', test, body } : null;
      }
      case NodeType.ReturnStatement: {
        if (node.argument) {
          if (this.currentReturnType === 'void') {
            return this.fail(node, 'a function declared to return void cannot return a value');
          }
          const value = this.expression(node.argument);
          return value ? { kind: 'return', value } : null;
        }
        if (this.currentReturnType && this.currentReturnType !== 'void') {
          return this.fail(node, `this function must return a value of type ${this.currentReturnType}`);
        }
        return { kind: 'return', value: null };
      }
      case NodeType.BreakStatement:
        return { kind: 'break' };
      case NodeType.ContinueStatement:
        return { kind: 'continue' };
      case NodeType.AsmBlock:
        return { kind: 'asm', text: node.body.slice(1, -1) };
      case NodeType.BlockStatement:
        return { kind: 'block', body: this.block(node) };
      default:
        return this.fail(node, `a ${node.type} statement is not compilable yet`);
    }
  }

  // A call can be a statement (its result, if any, discarded) or, now that
  // functions may return a value, a subexpression — `expression()` below
  // routes CallExpression here too. `memory.read`/`memory.write` are the one
  // namespace this milestone recognises: a compiler-owned intrinsic, not a
  // library import, because raw memory access has to exist before any
  // library can be written in terms of it. Any other member-access callee
  // (`screen.setBorderColor(...)`, `a.b()`) is not compilable yet — that is
  // real library/namespace support, which this milestone does not add.
  callExpression(node) {
    const callee = node.callee;
    if (
      callee.type === NodeType.MemberExpression
      && callee.object.type === NodeType.Identifier
      && callee.object.name === 'memory'
    ) {
      return this.memoryIntrinsic(node, callee);
    }
    if (callee.type !== NodeType.Identifier) {
      return this.fail(node, 'a call through member access is not compilable yet');
    }
    const args = [];
    for (const argument of node.args) {
      const lowered = this.expression(argument);
      if (!lowered) return null;
      args.push(lowered);
    }
    return {
      kind: 'call',
      name: callee.name,
      args,
      start: callee.start,
      length: callee.length,
    };
  }

  memoryIntrinsic(node, callee) {
    const member = callee.property.name;
    if (member === 'write') {
      if (node.args.length !== 2) {
        return this.fail(node, 'memory.write needs exactly two arguments: (address, value)');
      }
      const address = this.memoryArgument(node.args[0], 'usmallint');
      const value = this.memoryArgument(node.args[1], 'utinyint');
      if (!address || !value) return null;
      return { kind: 'memoryWrite', address, value, start: node.start, length: node.length };
    }
    if (member === 'read') {
      if (node.args.length !== 1) {
        return this.fail(node, 'memory.read needs exactly one argument: (address)');
      }
      const address = this.memoryArgument(node.args[0], 'usmallint');
      if (!address) return null;
      return { kind: 'memoryRead', address, start: node.start, length: node.length };
    }
    return this.fail(node, `memory.${member} is not compilable yet: only read and write exist`);
  }

  /**
   * Lower one `memory.read`/`memory.write` argument, range-checking it
   * against `typeName` when it is a literal — the same rule `let x: T = n`
   * gets, extended to the one built-in call whose parameter types the
   * compiler knows without a binder.
   */
  memoryArgument(node, typeName) {
    const value = this.expression(node);
    if (!value) return null;
    if (value.kind === 'const') {
      const { min, max } = resolveIntegerType(typeName);
      if (value.value < min || value.value > max) {
        this.diagnostics.push(diagnostic(
          Codes.VALUE_OUT_OF_RANGE,
          `${value.value} does not fit in ${typeName} (${min}..${max})`,
          this.file, node.start, node.length,
        ));
        return null;
      }
    }
    return value;
  }

  blockOrStatement(node) {
    if (node.type === NodeType.BlockStatement) return this.block(node);
    const lowered = this.statement(node);
    return lowered ? [lowered] : [];
  }

  assignment(node) {
    if (node.left.type !== NodeType.Identifier) {
      return this.fail(node.left, `assigning to a ${node.left.type} is not compilable yet`);
    }
    let value = this.expression(node.right);
    if (!value) return null;
    if (node.operator !== '=') {
      // `x += e` is `x = x + e`; the operator minus its trailing `=`.
      value = {
        kind: 'binop',
        operator: node.operator.slice(0, -1),
        left: { kind: 'ref', name: node.left.name, start: node.left.start, length: node.left.length },
        right: value,
      };
    }
    return {
      kind: 'assign', target: node.left.name, value,
      start: node.left.start, length: node.left.length,
    };
  }

  update(node) {
    if (node.argument.type !== NodeType.Identifier) {
      return this.fail(node.argument, `updating a ${node.argument.type} is not compilable yet`);
    }
    return {
      kind: 'assign',
      target: node.argument.name,
      start: node.argument.start,
      length: node.argument.length,
      value: {
        kind: 'binop',
        operator: node.operator === '++' ? '+' : '-',
        left: { kind: 'ref', name: node.argument.name, start: node.argument.start, length: node.argument.length },
        right: { kind: 'const', value: 1 },
      },
    };
  }

  expression(node) {
    switch (node.type) {
      case NodeType.IntegerLiteral:
        return { kind: 'const', value: node.value };
      case NodeType.BooleanLiteral:
        return { kind: 'const', value: node.value ? 1 : 0 };
      case NodeType.Identifier:
        // The span rides along so the linker can point a diagnostic at the
        // exact reference when a name resolves to nothing.
        return { kind: 'ref', name: node.name, start: node.start, length: node.length };
      case NodeType.BinaryExpression: {
        const left = this.expression(node.left);
        const right = this.expression(node.right);
        return left && right
          ? { kind: 'binop', operator: node.operator, left, right }
          : null;
      }
      case NodeType.UnaryExpression: {
        const argument = this.expression(node.argument);
        return argument ? { kind: 'unop', operator: node.operator, argument } : null;
      }
      case NodeType.CallExpression: {
        const call = this.callExpression(node);
        if (!call) return null;
        if (call.kind === 'memoryWrite') {
          return this.fail(node, 'memory.write does not return a value and cannot be used as an expression');
        }
        return call;
      }
      default:
        return this.fail(node, `a ${node.type} expression is not compilable yet`);
    }
  }
}

/**
 * Lower a parsed program to IR.
 *
 * @param {object} ast
 * @param {string} file
 * @returns {{ ir: IrProgram, diagnostics: object[] }}
 */
export function lower(ast, file = '<unknown>') {
  const lowering = new Lowering(file);
  const ir = lowering.program(ast);
  return { ir, diagnostics: lowering.diagnostics };
}
