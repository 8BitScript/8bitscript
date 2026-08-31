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
import { INTEGER_RANGES } from '../checker/index.mjs';

/**
 * @typedef {object} IrProgram
 * @property {IrGlobal[]} globals
 * @property {IrFunction[]} functions
 */

class Lowering {
  constructor(file) {
    this.file = file;
    this.diagnostics = [];
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
          // The resolver validates imports, but no linker exists to combine
          // modules, so a program that needs one cannot be compiled yet.
          this.fail(node, 'imports are not compilable yet: there is no linker');
          break;
        default:
          this.fail(node, `a top-level ${node.type} is not compilable yet`);
      }
    }
    return { globals: this.globals, functions: this.functions };
  }

  global(node) {
    const annotation = node.typeAnnotation;
    if (!annotation) {
      return this.fail(node, 'a global needs an explicit type to be compilable');
    }

    let type = annotation.name;
    let isVolatile = false;
    if (type === 'volatile') {
      const inner = annotation.typeArguments?.[0];
      if (!inner || !INTEGER_RANGES[inner.name]) {
        return this.fail(node, 'volatile<T> needs an integer T to be compilable');
      }
      type = inner.name;
      isVolatile = true;
    }
    if (!INTEGER_RANGES[type] && type !== 'bool') {
      return this.fail(node, `a global of type ${annotation.name} is not compilable yet`);
    }

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
    if (node.params.length > 0) {
      return this.fail(node, 'function parameters are not compilable yet');
    }
    const body = this.block(node.body);
    this.functions.push({
      name: node.name?.name ?? 'anonymous',
      exported: node.exported,
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
      case NodeType.ReturnStatement:
        if (node.argument) return this.fail(node, 'returning a value is not compilable yet');
        return { kind: 'return' };
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
        left: { kind: 'ref', name: node.left.name },
        right: value,
      };
    }
    return { kind: 'assign', target: node.left.name, value };
  }

  update(node) {
    if (node.argument.type !== NodeType.Identifier) {
      return this.fail(node.argument, `updating a ${node.argument.type} is not compilable yet`);
    }
    return {
      kind: 'assign',
      target: node.argument.name,
      value: {
        kind: 'binop',
        operator: node.operator === '++' ? '+' : '-',
        left: { kind: 'ref', name: node.argument.name },
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
        return { kind: 'ref', name: node.name };
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
