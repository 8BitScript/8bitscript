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
//
// And, like every layer before it, IT NEVER THROWS. `analyze()` runs this on
// every keystroke (see the package entry point), so a half-typed statement —
// `clearCell =` with nothing after it, `namespace` with no name — is normal
// input, not an exceptional one. The parser reports the syntax error and
// leaves a hole in the tree; a hole lowers to nothing, quietly, because the
// person has already been told about it.
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { NodeType } from '../ast/index.mjs';
import { resolveIntegerType } from '../types/index.mjs';
import {
  resolveScalarType, scanDeclaredTypes, parameterTypes, layoutTemplate, isTemplateCall, misplacedTemplate, resolveArrayType, typeForCount, MAX_STRING_LENGTH,
} from '../templates/index.mjs';

/**
 * @typedef {object} IrProgram
 * @property {IrImport[]} imports    Unresolved until the linker consumes them.
 * @property {IrGlobal[]} globals
 * @property {IrFunction[]} functions
 * @property {{ name: string, type: string, value: number, exported: boolean }[]} consts
 *   Top-level `const` declarations: compile-time constants the linker
 *   inlines at every reference. They never reach a backend.
 */

// ---- strings ------------------------------------------------------------------
//
// A string literal is constant program data: its bytes, length-prefixed
// (one byte, so at most 255 of them), in the program image — ROM on a
// cartridge, the .prg on a Commodore, a data segment on the web. A `string`
// value at runtime is a pointer to that. Lowering keeps a per-module table
// of them (`ir.strings`, deduplicated by content) and a literal lowers to
// `{ kind: 'string', index }`; the linker merges the tables and rebases the
// indices, and each backend emits the table in its own spelling.
//
// The portable character set and the 255-byte limit are the checker's
// rules (checker/index.mjs, UNPORTABLE_CHARACTER / STRING_TOO_LONG), so
// they reach the editor; check() always runs before lower(), so a string
// that gets here is one the checker accepted.

class Lowering {
  constructor(file) {
    this.file = file;
    this.diagnostics = [];
    this.imports = [];
    this.globals = [];
    this.functions = [];
    this.namespaces = [];
    this.strings = [];
    this.consts = [];
    // This module's own top-level consts, name to value, scanned in
    // program() before anything is lowered. A reference to one becomes the
    // value right here — so it reaches the literal-only positions a number
    // is allowed in (an `@address`, a `memory.write` argument's range
    // check, a global's initialiser) exactly as a literal would. An
    // *imported* const is not in this map: only the linker knows the other
    // module, so those are resolved there.
    this.ownConsts = new Map();
    // What lowering can know about names without a binder: this module's
    // own globals' and functions' declared types (scanned in program())
    // and the current function's parameters — what sizes a `${...}` field
    // from its expression when the width is left off (see templates/).
    this.globalTypes = new Map();
    this.functionTypes = new Map();
    this.functionArity = new Map();
    this.currentParams = new Map();
    this.currentArrayParams = new Map();
    // This module's own arrays, name to { type, length, constant }: what
    // `a[i]` and `a.length` mean here. An imported array is resolved by the
    // linker, which fills in the element type it cannot know from here.
    this.arrays = new Map();
    // This module's own string consts, name to string-table slot, and its
    // `string<N>` variables, name to capacity N.
    this.ownStrings = new Map();
    this.stringBuffers = new Map();
    // Own consts whose value only the linker can see (see global()): a
    // reference to one is a `ref`, not a declared name of this module.
    this.pendingConsts = new Set();
    // Every top-level const by name, whatever its value turns out to be.
    this.constNames = new Set();
  }

  /** The name scope a template field's type is inferred in. */
  get typeScope() {
    return {
      paramTypes: this.currentParams, globalTypes: this.globalTypes,
      functionTypes: this.functionTypes, arrayTypes: this.arrays,
    };
  }

  fail(node, message) {
    this.diagnostics.push(
      diagnostic(Codes.NOT_COMPILABLE, message, this.file, node.start, node.length),
    );
    return null;
  }

  program(ast) {
    ({
      globalTypes: this.globalTypes, functionTypes: this.functionTypes,
      arrayTypes: this.arrays, functionArity: this.functionArity,
    } = scanDeclaredTypes(ast));
    // In source order, so a const may be written in terms of one above it
    // (`const WIDE: u8 = CELL * 2;` is not folded — only a name or a
    // literal, the same narrowness the checker's own literal rule has).
    for (const node of ast.body) {
      if (node.type !== NodeType.VariableDeclaration || node.kind !== 'const' || !node.name) continue;
      this.constNames.add(node.name.name);
      const value = this.constInitialiser(node.initializer);
      if (value !== null) this.ownConsts.set(node.name.name, value);
    }
    for (const node of ast.body) {
      switch (node.type) {
        case NodeType.VariableDeclaration:
          this.global(node);
          break;
        case NodeType.FunctionDeclaration:
          this.function(node);
          break;
        case NodeType.NamespaceDeclaration:
          this.namespaceDeclaration(node);
          break;
        case NodeType.ImportDeclaration:
          this.import(node);
          break;
        default:
          this.fail(node, `a top-level ${node.type} is not compilable yet`);
      }
    }
    return {
      imports: this.imports,
      globals: this.globals,
      functions: this.functions,
      namespaces: this.namespaces,
      strings: this.strings,
      consts: this.consts,
    };
  }

  /**
   * The value of a top-level const's initialiser: a literal, a negated
   * literal, or a const declared above it. Null for anything else — an
   * imported name (the linker's job) or an expression (not folded).
   */
  constInitialiser(node) {
    if (!node) return null;
    if (node.type === NodeType.IntegerLiteral) return node.value;
    if (node.type === NodeType.BooleanLiteral) return node.value ? 1 : 0;
    if (
      node.type === NodeType.UnaryExpression
      && (node.operator === '-' || node.operator === '+')
      && node.argument?.type === NodeType.IntegerLiteral
    ) {
      return node.operator === '-' ? -node.argument.value : node.argument.value;
    }
    if (node.type === NodeType.Identifier) return this.ownConsts.get(node.name) ?? null;
    return null;
  }

  /**
   * A string literal (or a template's text run) as constant data: the IR
   * expression naming its slot in this module's string table.
   */
  stringConstant(node, value) {
    let index = this.strings.findIndex((s) => s.text === value);
    if (index === -1) {
      index = this.strings.length;
      this.strings.push({ text: value, bytes: [...value].map((ch) => ch.charCodeAt(0) & 0xFF) });
    }
    return { kind: 'string', index, start: node.start, length: node.length };
  }

  /** Is `name` a string here: a `string` parameter, a string const, or a `string<N>` variable? */
  isStringParameter(name) {
    if (this.currentParams.has(name)) return this.currentParams.get(name) === 'string';
    return this.ownStrings.has(name) || this.stringBuffers.has(name);
  }

  /** The lowered expression for a string by name (see isStringParameter). */
  stringRef(node) {
    if (!this.currentParams.has(node.name) && this.ownStrings.has(node.name)) {
      return { kind: 'string', index: this.ownStrings.get(node.name), start: node.start, length: node.length };
    }
    return { kind: 'ref', name: node.name, start: node.start, length: node.length };
  }

  /**
   * `text.print(cell, \`TICK ${ticks % 10:1} OPTION ${option}\`)`: a template
   * is laid out here, at compile time (templates/index.mjs does the layout;
   * the checker runs the same layout so its diagnostics reach the editor),
   * into the calls a person would have written by hand — one
   * `print(cell + offset, "TICK ")` per run of text and one
   * `printNumber(cell + offset, value, width)` per field, each at the cell
   * the runs before it add up to. Nothing formats at runtime: the
   * generated code is the hand-written version.
   *
   * It is a protocol on the callee's namespace, not a builtin: any
   * namespace exporting `print(cell, s: string)` and
   * `printNumber(cell, value, width)` accepts a template as `print`'s
   * second argument, and the linker resolves those two names the way it
   * resolves any namespace call.
   */
  templateCall(node) {
    const template = node.args[node.args.length - 1];
    if (!isTemplateCall(node)) {
      const namespace = node.callee.type === NodeType.MemberExpression && node.callee.object.type === NodeType.Identifier
        ? node.callee.object.name : null;
      this.diagnostics.push(misplacedTemplate(template, this.file, namespace));
      return null;
    }
    const namespace = node.callee.object.name;
    const { pieces, diagnostics } = layoutTemplate(template, this.typeScope, this.file, this.source);
    this.diagnostics.push(...diagnostics);
    if (diagnostics.length) return null;

    const cell = this.expression(node.args[0]);
    if (!cell) return null;
    // Each call gets its own copy of the cell expression: the linker renames
    // references in place, and one node shared between calls would be
    // renamed twice.
    const cellAt = (offset) => {
      if (cell.kind === 'const') return { kind: 'const', value: cell.value + offset };
      if (offset === 0) return structuredClone(cell);
      return { kind: 'binop', operator: '+', left: structuredClone(cell), right: { kind: 'const', value: offset } };
    };
    const call = (member, args) => ({
      kind: 'namespaceCall', namespace, member, args, start: node.start, length: node.length,
    });

    const body = [];
    for (const piece of pieces) {
      if (piece.kind === 'text') {
        const s = this.stringConstant(piece.node, piece.node.value);
        body.push(call('print', [cellAt(piece.offset), s]));
        continue;
      }
      const value = this.expression(piece.node.expression);
      if (!value) return null;
      body.push(call('printNumber', [cellAt(piece.offset), value, { kind: 'const', value: piece.width }]));
    }
    return body.length === 1 ? body[0] : { kind: 'block', body };
  }


  /**
   * `namespace screen { function setBorderColor(...) {...} const BLUE = 6; }`.
   *
   * A namespace has no runtime representation at all: a function member
   * lowers to an ordinary IR function under a mangled name (`screen_
   * setBorderColor`), and a const member is recorded as a plain number,
   * never emitted as storage. `screen.setBorderColor(...)` and `Color.Blue`
   * are resolved back to these by the linker, once it knows how `screen` (or
   * an import of it) was actually named in the calling module — lowering
   * itself only needs to record what this module's own namespaces contain.
   */
  namespaceDeclaration(node) {
    if (!node.name) return; // `namespace` with no name yet; the parser said so
    const name = node.name.name;
    const functions = new Map();
    const consts = new Map();

    for (const member of node.members) {
      if (!member) continue;
      if (member.type === NodeType.FunctionDeclaration) {
        const memberName = member.name?.name ?? 'anonymous';
        const mangled = `${name}_${memberName}`;
        this.function(member, { mangledName: mangled });
        functions.set(memberName, mangled);
        continue;
      }
      if (member.type === NodeType.VariableDeclaration) {
        if (member.kind !== 'const') {
          this.fail(member, 'a namespace member value must be declared with const, not let');
          continue;
        }
        const typeName = member.typeAnnotation?.name;
        const resolved = typeName && resolveScalarType(typeName);
        if (!resolved || resolved === 'void') {
          this.fail(member, `a namespace const of type ${typeName ?? '(none)'} is not compilable yet`);
          continue;
        }
        // The same initialisers a module-level const takes: a literal, or a
        // const — this module's own (a value by now), or one only the
        // linker can see (an imported const, `Other.MEMBER`), recorded
        // pending for it to resolve, range-check, and inline. A name this
        // module declares as storage is refused here: it is not a const.
        const init = member.initializer && this.expression(member.initializer);
        if (init?.kind === 'const') {
          consts.set(member.name.name, init.value);
          continue;
        }
        if (init?.kind === 'ref' && this.declares(init.name)) {
          this.fail(member.initializer, `'${init.name}' is not a const, so it cannot initialise a namespace const: an initialiser is a literal or a const`);
          continue;
        }
        if (init?.kind === 'ref' || init?.kind === 'namespaceConst') {
          consts.set(member.name.name, { pending: init, type: resolved });
          continue;
        }
        this.fail(member, 'a namespace const is initialised by a literal or a const');
        continue;
      }
      this.fail(member, `a ${member.type} is not compilable inside a namespace yet`);
    }

    this.namespaces.push({
      name, exported: node.exported ?? false, functions, consts,
      start: node.name.start, length: node.name.length,
    });
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
    if (!node.name) return null; // the parser reported the missing name
    const annotation = node.typeAnnotation;
    if (!annotation) {
      return this.fail(node, 'a global needs an explicit type to be compilable');
    }

    if (annotation.name === 'array') return this.arrayGlobal(node);
    if (annotation.name === 'string') return this.stringGlobal(node);

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
        // A const is a compile-time value, so it names an address as well
        // as a literal does — `@address(Vic.BorderColor)`. An imported one
        // cannot be seen from here; the message says so rather than
        // pretending the decorator only ever takes digits.
        const value = argument && this.constInitialiser(argument);
        if (value === null || value === undefined) {
          return this.fail(
            decorator,
            '@address needs one integer literal, or a const declared in this module',
          );
        }
        address = value;
      } else {
        return this.fail(decorator, `the @${decorator.name} decorator is not compilable yet`);
      }
    }

    let init = null;
    if (node.initializer) {
      init = this.expression(node.initializer);
      // A bare name that is not an own const (those became values in
      // expression()) is either an imported const — left for the linker,
      // the only layer that can see the other module — or a name this
      // module declares, which is not a compile-time value and is refused
      // here and now.
      if (init && init.kind === 'ref') {
        if (this.declares(init.name)) {
          return this.fail(
            node.initializer,
            `'${init.name}' is not a const, so it cannot initialise a global: an initialiser is a literal or a const`,
          );
        }
      } else if (init && init.kind === 'namespaceConst') {
        // `BorderColor.BLUE`: a const the linker resolves; left pending
        // the same way an imported const is.
      } else if (init && init.kind !== 'const') {
        return this.fail(node.initializer, 'a global initialiser must be a literal or a const to be compilable yet');
      }
    }
    if (address !== null && init) {
      return this.fail(node, 'an @address global maps hardware and cannot have an initialiser');
    }

    // `const` is a compile-time constant — one of the three spellings that
    // say "8bitscript resolves this" (a literal, a `const`, `#name(...)`).
    // It is recorded, never stored: the linker replaces every reference
    // with the value, so no backend ever sees it. `#frames(...)` has
    // already folded, so `const HALF: utinyint = #frames(0.5, seconds)` is
    // a literal by now.
    if (node.kind === 'const') {
      if (isVolatile || address !== null) {
        return this.fail(node, 'a const is a compile-time value; it cannot be volatile or mapped with @address');
      }
      if (!init) {
        return this.fail(node, 'a const needs a literal initialiser: it has no storage to assign later');
      }
      // `const HIGHLIGHT: utinyint = TextColor.YELLOW`, or `= Imported`: a
      // value only the linker can see, so this const is recorded pending
      // and is not in `ownConsts` — a reference to it stays a `ref` for
      // the linker to inline, like a reference to an imported const.
      const pending = init.kind === 'const' ? null : init;
      if (pending) this.pendingConsts.add(node.name.name);
      this.consts.push({
        name: node.name.name, type, value: pending ? null : init.value, ...(pending ? { pending } : {}),
        exported: node.exported ?? false,
        start: node.name.start, length: node.name.length,
      });
      return null;
    }

    this.globals.push({
      name: node.name.name, type, volatile: isVolatile, address,
      init: init ? (init.kind === 'const' ? init.value : init) : 0,
      exported: node.exported ?? false,
      // The name's span, so the linker's entry-export rule can point at it.
      start: node.name.start, length: node.name.length,
    });
  }

  /**
   * `const LABEL: string = "READY";` — a name for constant text: the
   * literal's slot in the string table, inlined wherever the name is read,
   * like a number const is. `let name: string<8>;` — text that changes: N
   * characters of RAM behind a length byte, the same length-prefixed shape
   * a literal has, so it goes wherever a `string` goes. It starts empty,
   * or `= "HI"` (which must fit); `name = "..."` / `name = other` copies at
   * runtime, cut to N; `name.length` and `name[i]` read it.
   */
  stringGlobal(node) {
    const annotation = node.typeAnnotation;
    const isConst = node.kind === 'const';
    if (node.decorators?.length) {
      return this.fail(node.decorators[0], 'a string is not mapped with @address: it is text in the program or in RAM');
    }
    if (isConst) {
      if (annotation.typeArguments?.length) {
        return this.fail(annotation, 'a const string is written `const NAME: string = "..."`: its length is the literal\'s');
      }
      if (node.initializer?.type !== NodeType.StringLiteral) {
        return this.fail(node.initializer ?? node, 'a const string needs a string literal: const NAME: string = "..."');
      }
      const slot = this.stringConstant(node.initializer, node.initializer.value);
      this.ownStrings.set(node.name.name, slot.index);
      this.consts.push({
        name: node.name.name, type: 'string', string: slot.index,
        exported: node.exported ?? false, start: node.name.start, length: node.name.length,
      });
      return null;
    }
    const size = annotation.typeArguments?.[0];
    const capacity = size?.type === NodeType.IntegerLiteral ? size.value
      : size?.type === NodeType.TypeReference && !size.typeArguments?.length ? (this.ownConsts.get(size.name) ?? null)
        : null;
    if (capacity === null || annotation.typeArguments.length !== 1) {
      return this.fail(annotation, 'a string variable needs a capacity: let name: string<N>, N an integer literal or a const declared in this module');
    }
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_STRING_LENGTH) {
      return this.fail(size, `a string capacity is 1..${MAX_STRING_LENGTH}, not ${capacity}`);
    }
    const init = new Array(capacity + 1).fill(0);
    if (node.initializer) {
      if (node.initializer.type !== NodeType.StringLiteral) {
        return this.fail(node.initializer, 'a string variable starts as a string literal, or empty');
      }
      const bytes = [...node.initializer.value].map((ch) => ch.charCodeAt(0) & 0xFF);
      if (bytes.length > capacity) {
        this.diagnostics.push(diagnostic(
          Codes.STRING_TOO_LONG,
          `"${node.initializer.value}" is ${bytes.length} characters and does not fit in string<${capacity}>`,
          this.file, node.initializer.start, node.initializer.length,
        ));
        return null;
      }
      init[0] = bytes.length;
      bytes.forEach((b, i) => { init[1 + i] = b; });
    }
    this.stringBuffers.set(node.name.name, capacity);
    this.globals.push({
      name: node.name.name, type: 'utinyint', array: capacity + 1, stringCapacity: capacity,
      constant: false, volatile: false, address: null, init,
      exported: node.exported ?? false, start: node.name.start, length: node.name.length,
    });
  }

  /**
   * `name = "..."` or `name = other` on a `string<N>`: a runtime copy, cut
   * to N. A literal is checked against N here; another string (a
   * parameter, a const, another variable) is cut when it is longer.
   */
  stringAssignment(node, capacity) {
    if (node.operator !== '=') {
      return this.fail(node, 'a string is assigned whole (s = ...); there is no string arithmetic');
    }
    if (node.right?.type === NodeType.StringLiteral && node.right.value.length > capacity) {
      this.diagnostics.push(diagnostic(
        Codes.STRING_TOO_LONG,
        `"${node.right.value}" is ${node.right.value.length} characters and does not fit in string<${capacity}>`,
        this.file, node.right.start, node.right.length,
      ));
      return null;
    }
    const source = this.expression(node.right);
    if (!source) return null;
    if (!this.isStringValue(source)) {
      return this.fail(node.right, `'${node.left.name}' is a string<${capacity}>: it is assigned a string — a literal, a const, a parameter, or another string variable`);
    }
    return {
      kind: 'stringCopy', target: { kind: 'ref', name: node.left.name, start: node.left.start, length: node.left.length },
      source, capacity, start: node.left.start, length: node.left.length,
    };
  }

  /** Is this lowered expression a string, as far as this module can tell? */
  isStringValue(expr) {
    if (expr.kind === 'string') return true;
    if (expr.kind !== 'ref') return false;
    // A parameter, a string variable, or — unknown here — an import the
    // linker will check.
    return this.currentParams.get(expr.name) === 'string'
      || this.stringBuffers.has(expr.name)
      || !(this.currentParams.has(expr.name) || this.globalTypes.has(expr.name)
        || this.functionTypes.has(expr.name) || this.arrays.has(expr.name) || this.ownConsts.has(expr.name));
  }

  /**
   * `let hp: array<utinyint, 4>;` — N elements of T in RAM, zero unless
   * written `= [..]`; `const TABLE: array<utinyint, 3> = [1, 2, 3];` — N
   * elements of T as data in the program, never in RAM; `@address(0x0400)
   * let screenRam: array<utinyint, 1000>;` — N cells of hardware, a name
   * for a fixed location as a scalar `@address` is. The length is part of
   * the type and every element is a compile-time value, so the whole
   * layout is decided here: `a.length` is a number, an initialiser has
   * exactly N elements, and a literal index past the end is a diagnostic.
   *
   * Unlike a scalar `const`, a const array is not inlined — it has an
   * address, because `TABLE[i]` with a runtime `i` needs one — so it is a
   * global with `constant: true`, and each backend places it read-only.
   */
  arrayGlobal(node) {
    const resolved = resolveArrayType(node.typeAnnotation, this.ownConsts);
    if (resolved.error) return this.fail(node.typeAnnotation, resolved.error);
    const { type, length } = resolved;
    const constant = node.kind === 'const';

    let address = null;
    for (const decorator of node.decorators ?? []) {
      if (decorator.name !== 'address') {
        return this.fail(decorator, `the @${decorator.name} decorator is not compilable yet`);
      }
      const value = decorator.args?.[0] && this.constInitialiser(decorator.args[0]);
      if (value === null || value === undefined) {
        return this.fail(decorator, '@address needs one integer literal, or a const declared in this module');
      }
      address = value;
    }

    let init = null;
    if (node.initializer) {
      if (address !== null) {
        return this.fail(node, 'an @address array maps hardware and cannot have an initialiser');
      }
      if (node.initializer.type !== NodeType.ArrayLiteral) {
        return this.fail(node.initializer, 'an array initialiser is written [v, v, ...]: one compile-time value per element');
      }
      const { elements } = node.initializer;
      if (elements.length !== length) {
        this.diagnostics.push(diagnostic(
          Codes.ARRAY_SIZE_MISMATCH,
          `'${node.name.name}' is an array<${type}, ${length}>, so its initialiser needs ${length} element${length === 1 ? '' : 's'}, not ${elements.length}`,
          this.file, node.initializer.start, node.initializer.length,
        ));
        return null;
      }
      init = [];
      const { min, max } = type === 'bool' ? { min: 0, max: 1 } : resolveIntegerType(type);
      for (const element of elements) {
        const value = this.expression(element);
        if (!value) return null;
        // `BorderColor.BLUE`, or an imported const: a compile-time value
        // only the linker can see. Left as is for it to fill in.
        if (value.kind === 'namespaceConst' || (value.kind === 'ref' && !this.declares(value.name))) {
          init.push(value);
          continue;
        }
        if (value.kind !== 'const') {
          return this.fail(element, 'an array element is a literal or a const: the data is laid out at compile time');
        }
        if (value.value < min || value.value > max) {
          this.diagnostics.push(diagnostic(
            Codes.VALUE_OUT_OF_RANGE, `${value.value} does not fit in ${type} (${min}..${max})`,
            this.file, element.start, element.length,
          ));
          return null;
        }
        init.push(value.value);
      }
    }
    if (constant && address !== null) {
      return this.fail(node, 'a const array is data in the program; it cannot be mapped with @address');
    }
    if (constant && !init) {
      return this.fail(node, 'a const array needs its values: const NAME: array<T, N> = [...]');
    }

    this.globals.push({
      name: node.name.name, type, array: length, constant, volatile: false, address, init,
      exported: node.exported ?? false,
      start: node.name.start, length: node.name.length,
    });
  }

  /**
   * What an `a` in `a[i]` / `a.length` / `a[i] = v` names, as far as this
   * module can tell: its own array (with everything known), a name it
   * declares that is not an array (refused), or a name it does not declare
   * — an import, left to the linker as a `ref` with `elementType: null`.
   */
  arrayReference(object, what) {
    if (object?.type !== NodeType.Identifier) {
      return this.fail(object ?? { start: 0, length: 0 }, `${what} is only compilable on an array by name`);
    }
    const name = object.name;
    const ref = { kind: 'ref', name, start: object.start, length: object.length };
    // An array parameter is the array it was handed, with its element type
    // and length known from its own type — so `t[i]` range-checks against
    // the declared length and `t.length` folds, exactly as for a global.
    if (this.currentArrayParams?.has(name)) {
      const p = this.currentArrayParams.get(name);
      return { ref, array: { type: p.elementType, length: p.length } };
    }
    if (this.currentParams.has(name)) {
      return this.fail(object, `'${name}' is a parameter or local, not an array: ${what} needs an array`);
    }
    if (this.arrays.has(name)) return { ref, array: this.arrays.get(name) };
    if (this.declares(name) || this.ownConsts.has(name) || this.pendingConsts.has(name)) {
      return this.fail(object, `'${name}' is not an array: ${what} needs an array<T, N>`);
    }
    return { ref, array: null };
  }

  /**
   * A parameter's default, lowered: a number, or a pending expression the
   * linker resolves (`BorderColor.BLACK`, an imported const). Null, with
   * a diagnostic, for anything that is not a compile-time value.
   */
  parameterDefault(p, type) {
    if (type === 'string') {
      const value = this.expression(p.defaultValue);
      if (!value) return null;
      if (value.kind !== 'string') return this.fail(p.defaultValue, 'a string parameter\'s default is a string literal or a string const');
      return value;
    }
    const value = this.expression(p.defaultValue);
    if (!value) return null;
    if (value.kind === 'namespaceConst' || (value.kind === 'ref' && !this.declares(value.name) && !this.currentParams.has(value.name))) {
      return value;
    }
    if (value.kind !== 'const') {
      return this.fail(p.defaultValue, 'a parameter default is a literal or a const: it is filled in at compile time');
    }
    const { min, max } = type === 'bool' ? { min: 0, max: 1 } : resolveIntegerType(type);
    if (value.value < min || value.value > max) {
      this.diagnostics.push(diagnostic(
        Codes.VALUE_OUT_OF_RANGE, `${value.value} does not fit in ${type} (${min}..${max})`,
        this.file, p.defaultValue.start, p.defaultValue.length,
      ));
      return null;
    }
    return value;
  }

  /**
   * The argument count of a call to one of this module's own functions,
   * against its parameters: too many, or fewer than those without a
   * default, is a diagnostic here so the editor sees it. Missing arguments
   * are filled in by the linker, which resolves every default.
   */
  checkArity(node, name, count) {
    const arity = this.functionArity.get(name);
    if (!arity || this.currentParams.has(name)) return true;
    if (count > arity.max || count < arity.min) {
      const takes = arity.min === arity.max ? `${arity.max}` : `${arity.min} to ${arity.max}`;
      this.diagnostics.push(diagnostic(
        Codes.WRONG_ARGUMENT_COUNT,
        `'${name}' takes ${takes} argument${arity.max === 1 ? '' : 's'}, not ${count}`,
        this.file, node.start, node.length,
      ));
      return false;
    }
    return true;
  }

  /** Does this module declare `name` as something other than a const — a global, function, array, or string? */
  declares(name) {
    if (this.constNames.has(name)) return false;
    return this.globalTypes.has(name) || this.functionTypes.has(name) || this.arrays.has(name) || this.stringBuffers.has(name);
  }

  /** Index range check for an own array with a literal index; true when it passed. */
  indexInRange(indexNode, index, array) {
    if (!array || index.kind !== 'const') return true;
    if (index.value < 0 || index.value >= array.length) {
      this.diagnostics.push(diagnostic(
        Codes.INDEX_OUT_OF_RANGE,
        `index ${index.value} is outside an array<${array.type}, ${array.length}>: elements are 0..${array.length - 1}`,
        this.file, indexNode.start, indexNode.length,
      ));
      return false;
    }
    return true;
  }

  /** `a[i]` as an IR read. */
  indexRead(node) {
    const target = this.arrayReference(node.object, 'indexing');
    if (!target) return null;
    const index = this.expression(node.index);
    if (!index || !this.indexInRange(node.index, index, target.array)) return null;
    return { kind: 'index', array: target.ref, index, elementType: target.array?.type ?? null };
  }

  function(node, { mangledName } = {}) {
    const params = [];
    for (const p of node.params) {
      const typeName = p.typeAnnotation?.name;
      // `t: array<utinyint, 4>` — the array itself, passed by reference.
      // The length is part of the type, so `t.length` is a constant inside
      // the callee and costs nothing at run time; the caller passes the
      // array's address and nothing is copied. Read-only for now: an
      // element is read (`t[i]`), never assigned through.
      if (typeName === 'array') {
        const resolved = resolveArrayType(p.typeAnnotation, this.ownConsts);
        if (resolved.error) return this.fail(p.typeAnnotation, resolved.error);
        if (p.defaultValue) {
          return this.fail(p, 'an array parameter has no default: an array is passed, never filled in');
        }
        if (params.some((q) => q.default !== undefined)) {
          return this.fail(p, `'${p.name.name}' needs a default: every parameter after one with a default has one`);
        }
        params.push({
          name: p.name.name, type: 'array', elementType: resolved.type, length: resolved.length,
        });
        continue;
      }
      const type = typeName && resolveScalarType(typeName, { allowString: true });
      if (!type || type === 'void') {
        return this.fail(p, `a parameter of type ${typeName ?? '(none)'} is not compilable yet`);
      }
      const param = { name: p.name.name, type };
      // A default is a compile-time value — a literal, a const, or a name
      // only the linker can see — filled in at each call that leaves the
      // argument off. Once one parameter has a default, the rest must too,
      // since arguments are matched by position.
      if (p.defaultValue) {
        const value = this.parameterDefault(p, type);
        if (value === null) return null;
        param.default = value;
      } else if (params.some((q) => q.default !== undefined)) {
        return this.fail(p, `'${p.name.name}' needs a default: every parameter after one with a default has one`);
      }
      params.push(param);
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
    const outerParams = this.currentParams;
    const outerArrayParams = this.currentArrayParams;
    this.currentReturnType = returnType;
    this.currentParams = parameterTypes(node);
    // Array parameters are kept apart from the scalar ones: `parameterTypes`
    // feeds type inference, which reasons about integers, and an array is
    // not one. What the body needs from them is the element type and the
    // length, so `t[i]` range-checks and `t.length` folds.
    this.currentArrayParams = new Map(
      params.filter((q) => q.type === 'array').map((q) => [q.name, q]),
    );
    // A parameter is declared in the body's block: `let x` over a
    // parameter x is a redeclaration, as it is in C.
    const outerBlock = this.blockNames;
    this.blockNames = new Set([...this.currentParams.keys(), ...this.currentArrayParams.keys()]);
    const body = this.functionBody(node.body);
    this.blockNames = outerBlock;
    this.currentReturnType = outerReturnType;
    this.currentParams = outerParams;
    this.currentArrayParams = outerArrayParams;

    this.functions.push({
      name: mangledName ?? (node.name?.name ?? 'anonymous'),
      // A namespace member is only ever reached through the namespace
      // (`screen.setBorderColor`, never `import { screen_setBorderColor }`);
      // its mangled name is never itself an exportable top-level binding.
      exported: mangledName ? false : node.exported,
      params,
      returnType,
      body,
      // The name's span, so the linker's entry-export rule can point at it.
      start: node.name?.start ?? node.start,
      length: node.name?.length ?? node.length,
    });
  }

  /** A function's body: its own scope, but the block the parameters are declared in. */
  functionBody(node) {
    const outer = this.currentParams;
    this.currentParams = new Map(outer);
    try {
      const out = [];
      for (const statement of node?.body ?? []) {
        const lowered = this.statement(statement);
        if (lowered) out.push(lowered);
      }
      return out;
    } finally {
      this.currentParams = outer;
    }
  }

  block(node) {
    return this.scoped(() => {
      const out = [];
      for (const statement of node?.body ?? []) {
        const lowered = this.statement(statement);
        if (lowered) out.push(lowered);
      }
      return out;
    });
  }

  /**
   * Run `fn` with a copy of the current names-in-scope, so a local declared
   * inside a block is not visible after it — block scoping, the same rule
   * C applies to block-scoped locals.
   */
  scoped(fn) {
    const outer = this.currentParams;
    const outerBlock = this.blockNames;
    this.currentParams = new Map(outer);
    this.blockNames = new Set();
    try {
      return fn();
    } finally {
      this.currentParams = outer;
      this.blockNames = outerBlock;
    }
  }

  /**
   * `let i: utinyint = 0;` inside a function: a local, storage that exists
   * while the function runs — the target's own stack or registers, as its
   * compiler sees fit. An initialiser is an expression (it runs); left off,
   * the local starts at 0 like a global does. A `const` here is refused:
   * a const is a compile-time value and lives at the top level.
   */
  local(node) {
    if (!node.name) return null; // the parser reported the missing name
    if (node.kind === 'const') {
      return this.fail(node, 'a const is a compile-time value declared at the top level of a module, not inside a function');
    }
    const annotation = node.typeAnnotation;
    if (!annotation) return this.fail(node, 'a local needs an explicit type to be compilable');
    if (annotation.name === 'array') {
      return this.fail(annotation, 'a local array is not compilable yet: declare the array at the top level');
    }
    const type = resolveScalarType(annotation.name);
    if (!type || annotation.typeArguments?.length) {
      return this.fail(annotation, `a local of type ${annotation.name} is not compilable yet: an integer or bool`);
    }
    for (const decorator of node.decorators ?? []) {
      return this.fail(decorator, `@${decorator.name} maps hardware; it belongs on a top-level declaration`);
    }
    // One declaration per name per block — the same rule C enforces,
    // reported here instead.
    if (this.blockNames?.has(node.name.name)) {
      return this.fail(node.name, `'${node.name.name}' is already declared in this block`);
    }
    const init = node.initializer ? this.expression(node.initializer) : { kind: 'const', value: 0 };
    if (!init) return null;
    if (init.kind === 'string') {
      return this.fail(node.initializer, `a string cannot initialise a ${type}: a string lives in a string<N> or a const`);
    }
    // In scope from here on: shadows a global, const, or array of the name.
    this.currentParams.set(node.name.name, type);
    this.blockNames?.add(node.name.name);
    return { kind: 'local', name: node.name.name, type, init, start: node.name.start, length: node.name.length };
  }

  /**
   * `for (let i: u8 = 0; i < 4; i++) { ... }`. Emitted as the target's own
   * `for` — not unrolled into a `while` — so `continue` still runs the
   * update, as it does everywhere else the syntax is used. The initialiser
   * is a local declaration or a statement; the update a statement; any of
   * the three may be left off.
   */
  forStatement(node) {
    return this.scoped(() => {
      let init = null;
      if (node.init) {
        init = node.init.type === NodeType.VariableDeclaration
          ? this.local(node.init)
          : this.expressionAsStatement(node.init, 'a for initialiser');
        if (!init) return null;
      }
      const test = node.test ? this.expression(node.test) : null;
      if (node.test && !test) return null;
      let update = null;
      if (node.update) {
        update = this.expressionAsStatement(node.update, 'a for update');
        if (!update) return null;
      }
      const body = this.blockOrStatement(node.body);
      return { kind: 'for', init, test, update, body };
    });
  }

  /** An expression in statement position: an assignment, `++`/`--`, or a call. */
  expressionAsStatement(e, what) {
    if (!e?.type) return null;
    if (e.type === NodeType.AssignmentExpression) return this.assignment(e);
    if (e.type === NodeType.UpdateExpression) return this.update(e);
    if (e.type === NodeType.CallExpression) return this.callExpression(e);
    return this.fail(e, `${what} is an assignment, ++/--, or a call, not a ${e.type}`);
  }

  statement(node) {
    // A hole the parser left behind: it has already reported the syntax
    // error, and there is nothing here to lower or to say twice.
    if (!node?.type) return null;
    switch (node.type) {
      case NodeType.ExpressionStatement: {
        const e = node.expression;
        if (e.type === NodeType.AssignmentExpression) return this.assignment(e);
        if (e.type === NodeType.UpdateExpression) return this.update(e);
        if (e.type === NodeType.CallExpression) {
          // A template string as the last argument is laid out into calls
          // here — a statement, since it expands to several.
          if (e.args[e.args.length - 1]?.type === NodeType.TemplateLiteral) return this.templateCall(e);
          return this.callExpression(e);
        }
        return this.fail(node, `a bare ${e.type} statement is not compilable yet`);
      }
      case NodeType.VariableDeclaration:
        return this.local(node);
      case NodeType.ForStatement:
        return this.forStatement(node);
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
  // routes CallExpression here too.
  //
  // `memory.read`/`memory.write` are a compiler-owned intrinsic, not a
  // namespace a module declares: raw memory access has to exist before any
  // library can be written in terms of it. Every other `object.member(...)`
  // callee is a namespace-qualified call — `screen.setBorderColor(...)` —
  // and lowering cannot know yet whether `screen` names a real namespace,
  // still less which module it came from: that needs the import graph, which
  // only the linker has. So this only records *what* was asked for; the
  // linker turns a resolved one into a plain `call` and reports an
  // unresolved one, exactly as it already does for a bare name.
  callExpression(node) {
    const callee = node.callee;
    if (!callee?.type) return null; // half-typed; the parser reported it
    if (callee.type === NodeType.MemberExpression && callee.object.type === NodeType.Identifier) {
      if (callee.object.name === 'memory') {
        return this.memoryIntrinsic(node, callee);
      }
      const args = [];
      for (const argument of node.args) {
        const lowered = this.expression(argument);
        if (!lowered) return null;
        args.push(lowered);
      }
      return {
        kind: 'namespaceCall',
        namespace: callee.object.name,
        member: callee.property.name,
        args,
        start: node.start,
        length: node.length,
      };
    }
    if (callee.type !== NodeType.Identifier) {
      return this.fail(node, 'a call through member access is not compilable yet');
    }
    // `waitFrame()` — block until the next logical frame. A builtin with its
    // own IR kind rather than a call to a function that exists somewhere:
    // every backend emits it differently (the 6502 backend as its frame-sync
    // runtime, the web backend as a host import), and it takes no arguments.
    // The name is reserved (checker/index.mjs's RESERVED_BUILTIN_NAMES), so
    // nothing a user declares can be what this refers to.
    if (callee.name === 'waitFrame') {
      if (node.args.length !== 0) {
        return this.fail(node, 'waitFrame() takes no arguments');
      }
      return { kind: 'waitFrame', start: node.start, length: node.length };
    }
    if (!this.checkArity(node, callee.name, node.args.length)) return null;
    const args = [];
    for (const argument of node.args) {
      // An array is handed over by name — `pick(STARTS, i)` — and this is
      // the one place its bare name is a value: the address of its first
      // element, nothing copied. Everywhere else a bare array name is an
      // error, because an array is otherwise used one element at a time.
      if (argument.type === NodeType.Identifier
        && !this.currentParams.has(argument.name)
        && (this.arrays.has(argument.name) || this.currentArrayParams.has(argument.name))) {
        args.push({ kind: 'ref', name: argument.name, start: argument.start, length: argument.length });
        continue;
      }
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
    if (!node?.type) return []; // `while (x)` with no body typed yet
    if (node.type === NodeType.BlockStatement) return this.block(node);
    return this.scoped(() => {
      const lowered = this.statement(node);
      return lowered ? [lowered] : [];
    });
  }

  assignment(node) {
    if (!node.left?.type) return null; // half-typed; the parser reported it
    if (node.left.type === NodeType.IndexExpression) {
      return this.indexStore(node.left, node.operator.slice(0, -1) || null, node.right);
    }
    if (node.left.type !== NodeType.Identifier) {
      return this.fail(node.left, `assigning to a ${node.left.type} is not compilable yet`);
    }
    if (this.arrays.has(node.left.name) && !this.currentParams.has(node.left.name)) {
      return this.fail(node.left, `'${node.left.name}' is an array: it is written one element at a time, ${node.left.name}[i] = ...`);
    }
    if (!this.currentParams.has(node.left.name) && this.stringBuffers.has(node.left.name)) {
      return this.stringAssignment(node, this.stringBuffers.get(node.left.name));
    }
    if (!this.currentParams.has(node.left.name) && this.ownStrings.has(node.left.name)) {
      this.diagnostics.push(diagnostic(
        Codes.ASSIGN_TO_CONST,
        `'${node.left.name}' is a const — a compile-time value with no storage — and cannot be assigned`,
        this.file, node.left.start, node.left.length,
      ));
      return null;
    }
    let value = this.expression(node.right);
    if (!value) return null;
    // A string into something this module knows is a number (a local, a
    // parameter, an own global); an imported target is the linker's to judge.
    if (value.kind === 'string' && (this.currentParams.has(node.left.name) || this.declares(node.left.name))) {
      return this.fail(node.right, `'${node.left.name}' is not a string: a string is assigned to a string<N>`);
    }
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

  /**
   * `a[i] = v`, `a[i] += v`, `a[i]++`: one element written. A const
   * array's elements are data in the program, and the checker has already
   * said so for this module's own; the linker says so for an imported one.
   * `operator` is the binary operator of a compound assignment (or null),
   * and `right` its right-hand side (or null for `++`/`--`, which is `+ 1`).
   */
  indexStore(left, operator, right) {
    if (left.object?.type === NodeType.Identifier && this.isStringParameter(left.object.name)) {
      return this.fail(left, `a string is assigned whole (${left.object.name} = "..."), not one character at a time`);
    }
    const target = this.arrayReference(left.object, 'assigning to an element');
    if (!target) return null;
    if (target.array?.constant) {
      this.diagnostics.push(diagnostic(
        Codes.ASSIGN_TO_CONST,
        `'${left.object.name}' is a const array — data in the program, not RAM — and cannot be assigned to`,
        this.file, left.object.start, left.object.length,
      ));
      return null;
    }
    const index = this.expression(left.index);
    if (!index || !this.indexInRange(left.index, index, target.array)) return null;
    let value = right ? this.expression(right) : { kind: 'const', value: 1 };
    if (!value) return null;
    if (operator) {
      // `a[i] += e` is `a[i] = a[i] + e`; the read gets its own copies of the
      // array and index nodes, since the linker renames in place.
      value = {
        kind: 'binop', operator,
        left: { kind: 'index', array: structuredClone(target.ref), index: structuredClone(index), elementType: target.array?.type ?? null },
        right: value,
      };
    }
    return {
      kind: 'storeIndex', array: target.ref, index, value, elementType: target.array?.type ?? null,
      start: left.object.start, length: left.object.length,
    };
  }

  update(node) {
    if (!node.argument?.type) return null; // half-typed; the parser reported it
    if (node.argument.type === NodeType.IndexExpression) {
      return this.indexStore(node.argument, node.operator === '++' ? '+' : '-', null);
    }
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
    if (!node?.type) return null; // a hole the parser already reported
    switch (node.type) {
      case NodeType.IntegerLiteral:
        return { kind: 'const', value: node.value };
      case NodeType.BooleanLiteral:
        return { kind: 'const', value: node.value ? 1 : 0 };
      case NodeType.StringLiteral:
        return this.stringConstant(node, node.value);
      case NodeType.TemplateLiteral:
        this.diagnostics.push(misplacedTemplate(node, this.file));
        return null;
      case NodeType.IndexExpression: {
        // `s[i]`: the i-th byte of a string parameter; otherwise `a[i]`, an
        // element of an array.
        if (node.object?.type === NodeType.Identifier && this.isStringParameter(node.object.name)) {
          const index = this.expression(node.index);
          if (!index) return null;
          return { kind: 'stringByte', string: this.stringRef(node.object), index };
        }
        return this.indexRead(node);
      }
      case NodeType.ArrayLiteral:
        return this.fail(node, 'an array literal only initialises an array<T, N> declaration');
      case NodeType.Identifier:
        // A const declared in this module is its value, here and now — but
        // a parameter of the same name shadows it, ordinary lexical scoping.
        if (!this.currentParams.has(node.name) && this.ownConsts.has(node.name)) {
          return { kind: 'const', value: this.ownConsts.get(node.name) };
        }
        if (!this.currentParams.has(node.name) && this.ownStrings.has(node.name)) {
          return { kind: 'string', index: this.ownStrings.get(node.name), start: node.start, length: node.length };
        }
        // An array is used one element at a time; its bare name is not a
        // value (there is no array assignment or array argument yet).
        if (!this.currentParams.has(node.name) && this.arrays.has(node.name)) {
          return this.fail(node, `'${node.name}' is an array: read an element (${node.name}[i]) or its .length`);
        }
        if (this.currentArrayParams?.has(node.name)) {
          return this.fail(node, `'${node.name}' is an array parameter: read an element (${node.name}[i]) or its .length`);
        }
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
        if (!argument) return null;
        // A signed literal is written `-128`, so a negated constant has to
        // *be* a constant — otherwise the narrowest thing a `tinyint` can
        // hold could not initialise one. Only `-`/`+`, whose meaning on a
        // number needs no width to know; `~` and `!` are left to the target.
        if (argument.kind === 'const' && (node.operator === '-' || node.operator === '+')) {
          return { kind: 'const', value: node.operator === '-' ? -argument.value : argument.value };
        }
        return { kind: 'unop', operator: node.operator, argument };
      }
      case NodeType.CallExpression: {
        const call = this.callExpression(node);
        if (!call) return null;
        if (call.kind === 'memoryWrite') {
          return this.fail(node, 'memory.write does not return a value and cannot be used as an expression');
        }
        if (call.kind === 'waitFrame') {
          return this.fail(node, 'waitFrame() does not return a value and cannot be used as an expression');
        }
        return call;
      }
      case NodeType.MemberExpression: {
        if (node.object.type !== NodeType.Identifier) {
          return this.fail(node, 'a member expression is not compilable yet');
        }
        // `s.length`: how many bytes a string parameter holds.
        if (this.isStringParameter(node.object.name)) {
          if (node.property.name !== 'length') {
            return this.fail(node, `a string has no '${node.property.name}'; it has .length and s[i]`);
          }
          return { kind: 'stringLength', string: this.stringRef(node.object) };
        }
        // `t.length` on an array parameter: the length is part of the
        // parameter's type, so it is a constant here and nothing about it
        // reaches the machine.
        if (this.currentArrayParams.has(node.object.name)) {
          if (node.property.name !== 'length') {
            return this.fail(node, `an array has no '${node.property.name}'; it has .length and a[i]`);
          }
          return { kind: 'const', value: this.currentArrayParams.get(node.object.name).length };
        }
        // `a.length` on this module's own array: a number, right here. On a
        // name this module does not declare it is left as a namespace const
        // — the linker turns it back into a length if the name resolves to
        // an imported array instead of a namespace.
        if (!this.currentParams.has(node.object.name) && this.arrays.has(node.object.name)) {
          if (node.property.name !== 'length') {
            return this.fail(node, `an array has no '${node.property.name}'; it has .length and a[i]`);
          }
          return { kind: 'const', value: this.arrays.get(node.object.name).length };
        }
        // `BorderColor.BLUE`: a namespace const used as a value, not a call.
        // Resolved by the linker the same way a namespace-qualified call is —
        // lowering only records which namespace and member were named.
        return {
          kind: 'namespaceConst',
          namespace: node.object.name,
          member: node.property.name,
          start: node.start,
          length: node.length,
        };
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
export function lower(ast, file = '<unknown>', source = null) {
  const lowering = new Lowering(file);
  lowering.source = source;
  const ir = lowering.program(ast);
  return { ir, diagnostics: lowering.diagnostics };
}

/**
 * The program's entry function, by output name, or null when the IR has none.
 *
 * Linked IR records it as `ir.entry` (the linker enforces exactly one
 * exported, parameterless function in the entry module). IR straight from
 * `lower()` — a single module, as the backends' own tests use — has no
 * linker to have decided, so the same rule is applied here after the fact:
 * the sole exported function, if there is exactly one. Both backends go
 * through this so "which function is the program" is decided in one place.
 *
 * @param {IrProgram & { entry?: string }} ir
 * @returns {string|null}
 */
export function entryOf(ir) {
  if (ir.entry) return ir.entry;
  const exported = ir.functions.filter((fn) => fn.exported);
  return exported.length === 1 ? exported[0].name : null;
}
