// The linker: one entry module in, one complete IR program out.
//
// It loads the module graph an entry file's imports name, runs the full front
// end over every module, and merges the results into a single IrProgram the
// backends already understand. Backends did not change for modules to arrive,
// and that is the point: linking happens entirely on the IR.
//
// Like the resolver, and for the same reason, this is a layer that touches the
// filesystem: the lexer, parser, checker, and lowering all stay pure, and the
// linker orchestrates them over real files.
//
// The model is per-module namespaces, the ones docs/packages.md promises: a
// module sees its own top-level declarations plus what it imports, and nothing
// else. Because the merged program is one flat C translation unit, symbols are
// renamed to keep modules apart — a symbol keeps its source name when it is
// free (the entry module loads first, so its names always survive, and `main`
// stays `main`), and takes a `_2`-style suffix when another module got there
// first. References are rewritten module by module, which is also what makes
// `import { x as y }` aliasing work.
//
// link() itself still emits every module's globals and functions whether
// the entry reaches them or not — checkHardwareHazards runs against that
// full set below (dead code with a dangerous write should still be caught),
// and every existing caller that inspects a linked ir.functions/ir.globals
// directly (mostly this file's own test suite) keeps seeing exactly what it
// always has. Compiling only what's reachable is each backend's own job now
// — see reachability.mjs, called right before lowering, once real numbers
// (measured on hello-world, of all programs) showed unreachable *code*
// mattering well before a package ships more than #define-cost registers.
//
// One deliberate absence still on record:
//   - asm6502 text is never rewritten. Inline assembly that names a symbol
//     sees the symbol's final, possibly-suffixed name — packages that ship
//     assembly should prefer names unlikely to collide.
import { readFileSync, realpathSync } from 'node:fs';

import { tokenize } from '../lexer/index.mjs';
import { parse } from '../parser/index.mjs';
import { check } from '../checker/index.mjs';
import { foldCompileTime } from '../fold/index.mjs';
import { lower } from '../ir/index.mjs';
import { resolveSpecifier, nativeSourcesBeside } from '../resolver/index.mjs';
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { storageBytes, resolveIntegerType, narrowestIntegerType } from '../types/index.mjs';
import { typeForCount, widerOf, COMPARISON_OPERATORS } from '../templates/index.mjs';
import { checkHardwareHazards } from './hazards.mjs';

/** The canonical identity of a file: two pnpm symlink routes, one module. */
function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Run the pure front end over one module's text. */
function loadModule(file, text, diagnostics, { frameRate, machine, facts }) {
  const { tokens, diagnostics: lexical } = tokenize(text, file);
  const { ast, diagnostics: syntax } = parse(tokens, text, file);
  diagnostics.push(...lexical, ...syntax);
  // Folding runs before check(): a #frames(...) call needs to already be a
  // plain IntegerLiteral by the time the width-fit rule walks the tree, so
  // e.g. #frames(100, seconds) overflowing a utinyint gets that diagnostic for free,
  // with no separate rule duplicating it here.
  diagnostics.push(...foldCompileTime(ast, file, { frameRate, machine, facts }));
  diagnostics.push(...check(ast, file, text));
  const { ir, diagnostics: lowering } = lower(ast, file, text);
  // The template layout runs in both check() (so the editor sees it) and
  // lower() (so a direct lower() can never drop a template silently); one
  // problem is reported once.
  const seen = new Set(diagnostics.map((d) => `${d.code}@${d.start}+${d.length}`));
  diagnostics.push(...lowering.filter((d) => !seen.has(`${d.code}@${d.start}+${d.length}`)));
  return { file, ir };
}

/**
 * Discover and load every module reachable from the entry.
 *
 * Cycles are permitted: a module already loaded is bound to, not reloaded.
 * Globals initialize to literals only, so no initialisation-order problem
 * exists for a cycle to cause.
 */
function loadGraph(entryText, entryFile, diagnostics, sources, options) {
  const modules = [];
  const byPath = new Map();
  // A package's "8bitscript".native files (see the resolver), collected
  // once each however many modules import the package — keyed by canonical
  // path for the same pnpm-symlink reason `byPath` is.
  const nativeSources = new Map();

  const enqueue = (file, text) => {
    const module = loadModule(file, text, diagnostics, { frameRate: options.frameRate, machine: options.machine, facts: options.facts });
    modules.push(module);
    byPath.set(canonical(file), module);
    sources.set(file, text);
    return module;
  };

  enqueue(entryFile, entryText);
  // The entry's own package, if it sits inside one that ships native
  // sources (a package's probe program under its test/ directory).
  for (const source of nativeSourcesBeside(entryFile).native ?? []) {
    nativeSources.set(canonical(source), source);
  }

  // modules grows while we walk it: a plain index loop is the worklist.
  for (let i = 0; i < modules.length; i += 1) {
    const module = modules[i];
    for (const imp of module.ir.imports) {
      const resolved = resolveSpecifier(imp.source, module.file, options);
      if (!resolved) {
        diagnostics.push(diagnostic(
          Codes.NOT_COMPILABLE,
          `import specifier '${imp.source}' is not linkable yet: only './file.8bs' paths, bare package names, and package subpaths ('@scope/name/thing') are specified`,
          module.file, imp.start, imp.length,
        ));
        continue;
      }
      if (resolved.code) {
        diagnostics.push(diagnostic(resolved.code, resolved.message, module.file, imp.start, imp.length));
        continue;
      }
      if (resolved.path === null) {
        // A conditional package entry, or a file that exists only in
        // per-machine versions, with no machine to choose by: the caller
        // linked without one, and guessing a machine would be worse.
        diagnostics.push(diagnostic(
          Codes.NOT_COMPILABLE,
          `'${imp.source}' is target-specific; linking it needs a machine target`,
          module.file, imp.start, imp.length,
        ));
        continue;
      }
      const key = canonical(resolved.path);
      if (!byPath.has(key)) {
        let text;
        try {
          text = readFileSync(resolved.path, 'utf8');
        } catch {
          diagnostics.push(diagnostic(
            Codes.UNRESOLVED_RELATIVE_IMPORT,
            `cannot read module '${imp.source}'`,
            module.file, imp.start, imp.length,
          ));
          continue;
        }
        enqueue(resolved.path, text);
      }
      imp.module = byPath.get(key);
      for (const source of resolved.native ?? []) {
        nativeSources.set(canonical(source), source);
      }
    }
  }

  return { modules, nativeSources: [...nativeSources.values()] };
}

/** Every top-level name a module declares, mapped to whether it is exported. */
function declarationsOf(module) {
  const decls = new Map();
  for (const g of module.ir.globals) decls.set(g.name, g.exported);
  for (const f of module.ir.functions) decls.set(f.name, f.exported);
  for (const c of module.ir.consts ?? []) decls.set(c.name, c.exported);
  return decls;
}

/** This module's own globals, by their original (pre-rename) name. */
function globalsOf(module) {
  return new Map(module.ir.globals.map((g) => [g.name, g]));
}

/**
 * The global a name in `module` refers to — its own, or the one an import
 * binds — or null when it names something else (a function, a const, a
 * parameter). Used for what only the whole program can know about an
 * array: an importer's `a[i]` needs the element type, and a store into an
 * imported const array is refused here.
 */
function globalNamed(module, name) {
  if (module.globalsByName.has(name)) return module.globalsByName.get(name);
  const binding = module.bindings?.get(name);
  return binding ? (binding.module.globalsByName.get(binding.name) ?? null) : null;
}

/** Does `name`, in this function's scope, refer to something another module declares? */
function isImportedName(module, scope, name) {
  return !module.globalsByName.has(name) && !scope.bound?.has(name) && module.bindings?.has(name);
}

/**
 * A scope for a nested block: the enclosing names, plus whatever locals
 * the block declares — which go out of scope with it. `bound` is the set
 * of names a parameter or local binds in the function, for the rules that
 * ask "is this an import?".
 */
function childScope(scope) {
  const child = new Map(scope);
  child.bound = new Set(scope.bound ?? []);
  return child;
}

/** Bind a parameter or local: never renamed, and it shadows everything else of the name. */
function bindLocal(scope, name) {
  scope.set(name, name);
  if (!scope.bound) scope.bound = new Set();
  scope.bound.add(name);
}

/**
 * Resolve the array an `index`/`storeIndex` node names: rename its `ref`,
 * fill in the element type lowering could not see, and check what only
 * this layer can. `expr.array` is the ref; own-module problems were
 * reported when the module was lowered, so only an imported array is
 * examined here.
 */
function rewriteArrayAccess(expr, scope, module, diagnostics, { store = false } = {}) {
  const name = expr.array.name;
  const imported = isImportedName(module, scope, name);
  rewriteExpression(expr.array, scope, module, diagnostics);
  rewriteExpression(expr.index, scope, module, diagnostics);
  if (!imported || expr.array.kind !== 'ref') return;
  const g = globalNamed(module, name);
  const at = (code, message) => diagnostics.push(diagnostic(code, message, module.file, expr.array.start ?? 0, expr.array.length ?? 0));
  if (!g || !g.array) {
    at(Codes.NOT_COMPILABLE, `'${name}' is not an array: ${store ? 'assigning to an element' : 'indexing'} needs an array<T, N>`);
    return;
  }
  expr.elementType = g.type;
  if (store && g.constant) {
    at(Codes.ASSIGN_TO_CONST, `'${name}' is a const array — data in the program, not RAM — and cannot be assigned to`);
  }
  if (expr.index.kind === 'const' && (expr.index.value < 0 || expr.index.value >= g.array)) {
    at(Codes.INDEX_OUT_OF_RANGE, `index ${expr.index.value} is outside an array<${g.type}, ${g.array}>: elements are 0..${g.array - 1}`);
  }
}

/**
 * A pending initializer — an imported const by name, or `Namespace.Member`
 * — as the number it stands for, range-checked against the global's type.
 * Anything else is reported and stands in as 0.
 */
function resolveInitialiser(expr, g, scope, module, diagnostics) {
  const at = (code, message) => diagnostics.push(diagnostic(code, message, module.file, expr.start ?? 0, expr.length ?? 0));
  if (expr.kind === 'ref' && typeof module.constValues.get(expr.name) === 'object') {
    at(Codes.NOT_COMPILABLE, `'${expr.name}' is a string const; it cannot initialize a ${g.type}`);
    return 0;
  }
  if (expr.kind === 'ref' && !module.constValues.has(expr.name)) {
    at(scope.has(expr.name) ? Codes.NOT_COMPILABLE : Codes.UNRESOLVED_NAME,
      scope.has(expr.name)
        ? `'${expr.name}' is not a const, so it cannot initialize a global: an initializer is a literal or a const`
        : `cannot find name '${expr.name}'`);
    return 0;
  }
  const before = diagnostics.length;
  rewriteExpression(expr, scope, module, diagnostics);
  if (diagnostics.length > before) return 0;
  if (expr.kind !== 'const') {
    at(Codes.NOT_COMPILABLE, 'an initializer is a literal or a const');
    return 0;
  }
  const range = g.type === 'bool' ? { min: 0, max: 1 } : resolveIntegerType(g.type);
  if (expr.value < range.min || expr.value > range.max) {
    at(Codes.VALUE_OUT_OF_RANGE, `${expr.value} does not fit in ${g.type} (${range.min}..${range.max})`);
    return 0;
  }
  return expr.value;
}

/**
 * A call, once its callee is an output name: the argument count checked
 * against the parameters, and every argument left off filled in from the
 * parameter's default — a value 8bitscript resolved, so the machine sees
 * a complete call. Too many, or fewer than the parameters without a
 * default, is WRONG_ARGUMENT_COUNT.
 */
function completeCall(call, module, diagnostics) {
  const fn = module.program?.functionsByOutput?.get(call.name);
  if (!fn) return;
  const min = fn.params.filter((p) => p.default === undefined).length;
  const max = fn.params.length;
  if (call.args.length > max || call.args.length < min) {
    const takes = min === max ? `${max}` : `${min} to ${max}`;
    diagnostics.push(diagnostic(
      Codes.WRONG_ARGUMENT_COUNT,
      `'${call.original ?? call.name}' takes ${takes} argument${max === 1 ? '' : 's'}, not ${call.args.length}`,
      module.file, call.start ?? 0, call.length ?? 0,
    ));
    return;
  }
  for (let i = call.args.length; i < max; i += 1) call.args.push(structuredClone(fn.params[i].default));
}

/**
 * This module's own top-level consts, name to value — a number, or for a
 * string const `{ string: slot }` in the module's own string table (moved
 * to the program's table in link(), once that exists).
 */
function constsOf(module) {
  return new Map((module.ir.consts ?? []).map((c) => [
    c.name,
    c.pending ? { pending: c.pending, type: c.type } : c.type === 'string' ? { string: c.string } : c.value,
  ]));
}

/**
 * A const whose initializer only the linker can see — `const HIGHLIGHT:
 * utinyint = TextColor.YELLOW`, or `= Imported` — gets its value here,
 * before any module inlines it. A pending const may name another pending
 * const (in any module), so this repeats until nothing changes; what is
 * still pending then is a cycle, and is reported.
 */
function resolvePendingConsts(modules, diagnostics) {
  // Every const slot the linker may still owe a value: the module's own
  // top-level consts, and the const members of each of its namespaces
  // (`namespace text { const COLUMNS: utinyint = Video.COLUMNS; }`), which
  // take the same initializers and resolve by the same rule.
  const pendingOf = (module) => [
    ...[...module.ownConsts].filter(([, v]) => v?.pending)
      .map(([name, v]) => ({ name, ...v, table: module.ownConsts })),
    ...[...module.namespaces.values()].flatMap((ns) => [...ns.consts]
      .filter(([, v]) => v?.pending)
      .map(([member, v]) => ({ name: `${ns.name}.${member}`, ...v, table: ns.consts, key: member }))),
  ];
  const settle = (slot, value) => slot.table.set(slot.key ?? slot.name, value);
  const scopes = new Map(modules.map((m) => [m, new Map(m.rename)]));
  for (let progress = true; progress;) {
    progress = false;
    for (const module of modules) {
      for (const slot of pendingOf(module)) {
        const { pending, type } = slot;
        const expr = structuredClone(pending);
        if (expr.kind === 'ref') {
          // Own const first (a chain inside one module), then an import.
          const binding = module.ownConsts.has(expr.name)
            ? { module, name: expr.name } : module.bindings.get(expr.name);
          const other = binding && binding.module.ownConsts.get(binding.name);
          if (other?.pending) continue; // not yet; another pass
          if (other === undefined) {
            diagnostics.push(diagnostic(
              binding ? Codes.NOT_COMPILABLE : Codes.UNRESOLVED_NAME,
              binding ? `'${expr.name}' is not a const, so it cannot initialize a const` : `cannot find name '${expr.name}'`,
              module.file, expr.start ?? 0, expr.length ?? 0,
            ));
            settle(slot, 0);
            progress = true;
            continue;
          }
        } else if (expr.kind === 'namespaceConst') {
          // `Other.MEMBER`: a member still pending waits for another pass;
          // a namespace or member that does not exist is left to
          // rewriteExpression below, which reports it.
          const result = resolveNamespaceMember(module, expr.namespace, expr.member, 'consts');
          if (result.namespaceFound && result.memberFound && result.value?.pending) continue;
        }
        // constValues is what rewriteExpression inlines from; for this pass
        // it is the module's own resolved consts plus its imports' values.
        module.constValues = new Map([...module.ownConsts].filter(([, v]) => !v?.pending));
        for (const [local, binding] of module.bindings) {
          const v = binding.module.ownConsts.get(binding.name);
          if (v !== undefined && !v?.pending) module.constValues.set(local, v);
        }
        settle(slot, resolveInitialiser(expr, { type }, scopes.get(module), module, diagnostics));
        progress = true;
      }
    }
  }
  for (const module of modules) {
    for (const slot of pendingOf(module)) {
      diagnostics.push(diagnostic(
        Codes.NOT_COMPILABLE,
        `'${slot.name}' is a const whose value depends on itself, through the consts it names`,
        module.file, slot.pending.start ?? 0, slot.pending.length ?? 0,
      ));
      settle(slot, 0);
    }
  }
}

/** A const's inlined value as an IR expression: a number, or a string slot. */
function constExpression(value) {
  return typeof value === 'object' ? { kind: 'string', index: value.string } : { kind: 'const', value };
}

/** Is `name` a string in this scope — a parameter or local, a string const, or a string<N> variable? */
function isStringName(module, scope, name) {
  if (scope.bound?.has(name)) return true; // a parameter's type is the callee's business; lowering checked its own
  if (typeof module.constValues.get(name) === 'object') return true;
  return Boolean(globalNamed(module, name)?.stringCapacity);
}

/** A string source checked against a `string<N>` target's capacity, for a literal. */
function checkStringFits(source, capacity, ir, module, diagnostics) {
  if (source.kind !== 'string') return;
  const s = ir.strings[source.index];
  if (s.bytes.length > capacity) {
    diagnostics.push(diagnostic(
      Codes.STRING_TOO_LONG,
      `"${s.text}" is ${s.bytes.length} characters and does not fit in string<${capacity}>`,
      module.file, source.start ?? 0, source.length ?? 0,
    ));
  }
}

/** This module's own namespace declarations, keyed by namespace name. */
function namespacesOf(module) {
  return new Map((module.ir.namespaces ?? []).map((ns) => [ns.name, ns]));
}

/**
 * Check import bindings: every imported name must be exported by the module
 * its specifier resolved to, and must not collide with a declaration or
 * another import in the importing module. A namespace import binds
 * separately from a value/function import — `screen` names a namespace, not
 * something a bare `ref` could ever resolve to.
 */
function bindImports(modules, diagnostics) {
  for (const module of modules) {
    module.decls = declarationsOf(module);
    module.globalsByName = globalsOf(module);
    module.namespaces = namespacesOf(module);
    module.ownConsts = constsOf(module);
    module.bindings = new Map();
    module.namespaceBindings = new Map();
  }
  for (const module of modules) {
    for (const imp of module.ir.imports) {
      if (!imp.module) continue; // resolution already failed and reported
      for (const spec of imp.specifiers) {
        if (
          module.decls.has(spec.local)
          || module.bindings.has(spec.local)
          || module.namespaceBindings.has(spec.local)
        ) {
          diagnostics.push(diagnostic(
            Codes.DUPLICATE_BINDING,
            `'${spec.local}' is already bound in this module`,
            module.file, spec.start, spec.length,
          ));
          continue;
        }
        const importedNamespace = imp.module.namespaces.get(spec.imported);
        if (importedNamespace?.exported) {
          module.namespaceBindings.set(spec.local, { module: imp.module, name: spec.imported });
          continue;
        }
        if (imp.module.decls.get(spec.imported) !== true) {
          diagnostics.push(diagnostic(
            Codes.NO_SUCH_EXPORT,
            `'${spec.imported}' is not exported by '${imp.source}'`,
            module.file, spec.start, spec.length,
          ));
          continue;
        }
        module.bindings.set(spec.local, { module: imp.module, name: spec.imported });
      }
    }
  }
}

/**
 * Resolve `namespace.member` against a module's own namespace declarations
 * or, failing that, its namespace imports — the same two-step lookup a plain
 * `ref` gets from `scope`, just kept separate because a namespace member
 * resolves to a *mangled function name* or a *literal value*, never to an
 * output-renamed binding by itself.
 *
 * @param {'functions'|'consts'} table
 */
function resolveNamespaceMember(module, namespaceName, memberName, table) {
  const own = module.namespaces.get(namespaceName);
  if (own) {
    const value = own[table].get(memberName);
    return { namespaceFound: true, memberFound: value !== undefined, value, targetModule: module };
  }
  const binding = module.namespaceBindings.get(namespaceName);
  if (!binding) return { namespaceFound: false };
  const target = binding.module.namespaces.get(binding.name);
  if (!target) return { namespaceFound: false };
  const value = target[table].get(memberName);
  return { namespaceFound: true, memberFound: value !== undefined, value, targetModule: binding.module };
}

/**
 * Give every declaration its output name. First come keeps the source name;
 * the entry module comes first, so user-facing names — `main` above all —
 * never change. Later modules take `name_2`, `name_3`, … on collision.
 */
function assignOutputNames(modules) {
  const taken = new Set();
  for (const module of modules) {
    module.rename = new Map();
    for (const name of module.decls.keys()) {
      // A const has no output at all: it is inlined wherever it is read.
      if (module.ownConsts.has(name)) continue;
      let out = name;
      for (let n = 2; taken.has(out); n += 1) out = `${name}_${n}`;
      taken.add(out);
      module.rename.set(name, out);
    }
  }
}

function rewriteExpression(expr, scope, module, diagnostics) {
  switch (expr.kind) {
    case 'ref': {
      const out = scope.get(expr.name);
      if (out === undefined && module.constValues.has(expr.name)) {
        // A const, this module's own or imported: the value, inlined. A
        // parameter of the same name is in `scope` and so shadowed it above.
        const value = constExpression(module.constValues.get(expr.name));
        delete expr.name;
        if (value.kind === 'const') { delete expr.start; delete expr.length; }
        Object.assign(expr, value);
        return;
      }
      if (out === undefined) {
        // A parameter is already in `scope` (mapped to itself — see `link()`),
        // so anything still unresolved here is a typo or a missing import,
        // and letting it through would risk it silently capturing another
        // module's renamed symbol.
        diagnostics.push(diagnostic(
          Codes.UNRESOLVED_NAME,
          `cannot find name '${expr.name}'`,
          module.file, expr.start ?? 0, expr.length ?? 0,
        ));
        return;
      }
      expr.name = out;
      return;
    }
    case 'binop':
      rewriteExpression(expr.left, scope, module, diagnostics);
      rewriteExpression(expr.right, scope, module, diagnostics);
      // Recomputed, not trusted from lowering: an operand that was a
      // pending namespaceConst (an imported array's .length, say) had no
      // type yet when lowering first guessed this binop's — only after
      // both sides are rewritten, just above, can the real one be known.
      expr.type = COMPARISON_OPERATORS.has(expr.operator) ? 'bool' : widerOf(expr.left.type, expr.right.type);
      return;
    case 'unop':
      rewriteExpression(expr.argument, scope, module, diagnostics);
      return;
    case 'string':
      // The module's own string table was merged into the program's (see
      // link()); the slot number moves with it.
      expr.index = module.stringMap[expr.index];
      return;
    case 'stringLength':
      rewriteExpression(expr.string, scope, module, diagnostics);
      return;
    case 'stringByte':
      rewriteExpression(expr.string, scope, module, diagnostics);
      rewriteExpression(expr.index, scope, module, diagnostics);
      return;
    case 'index': {
      const imported = isImportedName(module, scope, expr.array.name);
      const buffer = imported ? globalNamed(module, expr.array.name) : null;
      const stringConst = imported && typeof module.constValues.get(expr.array.name) === 'object';
      if (buffer?.stringCapacity || stringConst) {
        // `s[i]` on an imported string<N>: lowering could not tell it from
        // an array; it is the i-th character, as it is for a string parameter.
        rewriteExpression(expr.array, scope, module, diagnostics);
        rewriteExpression(expr.index, scope, module, diagnostics);
        expr.kind = 'stringByte';
        expr.string = expr.array;
        delete expr.array;
        delete expr.elementType;
        return;
      }
      rewriteArrayAccess(expr, scope, module, diagnostics);
      return;
    }
    case 'call': {
      const out = scope.get(expr.name);
      if (out === undefined) {
        diagnostics.push(diagnostic(
          Codes.UNRESOLVED_NAME,
          `cannot find name '${expr.name}'`,
          module.file, expr.start ?? 0, expr.length ?? 0,
        ));
      } else {
        expr.original = expr.name;
        expr.name = out;
      }
      for (const argument of expr.args) rewriteExpression(argument, scope, module, diagnostics);
      // After the caller's own arguments: a filled-in default is already
      // in the program's terms (its string slot rebased by its own module).
      if (out !== undefined) { completeCall(expr, module, diagnostics); delete expr.original; }
      return;
    }
    case 'memoryRead':
      // `memory` names nothing to resolve — it is a compiler intrinsic, not
      // an import — but its address argument can still reference a global.
      rewriteExpression(expr.address, scope, module, diagnostics);
      return;
    case 'namespaceCall': {
      const result = resolveNamespaceMember(module, expr.namespace, expr.member, 'functions');
      if (!result.namespaceFound) {
        diagnostics.push(diagnostic(
          Codes.UNRESOLVED_NAME,
          `cannot find namespace '${expr.namespace}'`,
          module.file, expr.start ?? 0, expr.length ?? 0,
        ));
      } else if (!result.memberFound) {
        diagnostics.push(diagnostic(
          Codes.NO_SUCH_EXPORT,
          `'${expr.member}' is not a function in namespace '${expr.namespace}'`,
          module.file, expr.start ?? 0, expr.length ?? 0,
        ));
      } else {
        // Once resolved, a namespace call IS a plain call — same shape the
        // rest of the pipeline (and both backends) already understand.
        expr.kind = 'call';
        expr.original = `${expr.namespace}.${expr.member}`;
        expr.name = result.targetModule.rename.get(result.value);
        delete expr.namespace;
        delete expr.member;
      }
      for (const argument of expr.args) rewriteExpression(argument, scope, module, diagnostics);
      if (expr.kind === 'call') { completeCall(expr, module, diagnostics); delete expr.original; }
      return;
    }
    case 'namespaceConst': {
      const result = resolveNamespaceMember(module, expr.namespace, expr.member, 'consts');
      const array = !result.namespaceFound && !module.globalsByName.has(expr.namespace)
        ? globalNamed(module, expr.namespace) : null;
      const stringConst = !result.namespaceFound && isImportedName(module, scope, expr.namespace)
        && typeof module.constValues.get(expr.namespace) === 'object';
      if (stringConst && expr.member === 'length') {
        // `Label.length` on an imported string const: the literal's length byte.
        expr.kind = 'stringLength';
        expr.type = 'utinyint';
        expr.string = constExpression(module.constValues.get(expr.namespace));
        delete expr.namespace;
        delete expr.member;
        return;
      }
      if (array?.stringCapacity && expr.member === 'length') {
        // `name.length` on an imported string<N>: the length byte, at runtime.
        const ref = { kind: 'ref', name: expr.namespace, start: expr.start, length: expr.length };
        rewriteExpression(ref, scope, module, diagnostics);
        expr.kind = 'stringLength';
        expr.type = 'utinyint';
        expr.string = ref;
        delete expr.namespace;
        delete expr.member;
        return;
      }
      if (array?.array && expr.member === 'length') {
        // `buffer.length` on an imported array: lowering could not tell it
        // from a namespace const, so it arrives as one. A number, like an
        // own array's length is — same rule, same type (typeForCount),
        // just resolved a pass later because the length itself was.
        expr.kind = 'const';
        expr.value = array.array;
        expr.type = typeForCount(array.array);
        delete expr.namespace;
        delete expr.member;
        delete expr.start;
        delete expr.length;
        return;
      }
      if (!result.namespaceFound) {
        diagnostics.push(diagnostic(
          Codes.UNRESOLVED_NAME,
          `cannot find namespace '${expr.namespace}'`,
          module.file, expr.start ?? 0, expr.length ?? 0,
        ));
      } else if (!result.memberFound) {
        diagnostics.push(diagnostic(
          Codes.NO_SUCH_EXPORT,
          `'${expr.member}' is not a const in namespace '${expr.namespace}'`,
          module.file, expr.start ?? 0, expr.length ?? 0,
        ));
      } else {
        // A genuine namespace const (`BorderColor.BLUE`): inlined as a
        // plain value, same as one of this module's own consts. Its
        // declared type is not tracked across the import boundary (own
        // consts aren't always either — see ownConstTypes in ir/index.mjs),
        // so it gets the same narrowest-fit fallback an untracked own
        // const would.
        expr.kind = 'const';
        expr.value = result.value;
        expr.type = narrowestIntegerType(result.value);
        delete expr.namespace;
        delete expr.member;
        delete expr.start;
        delete expr.length;
      }
      return;
    }
    default: // 'const' names nothing
  }
}

function rewriteStatement(statement, scope, module, diagnostics) {
  switch (statement.kind) {
    case 'assign': {
      const out = scope.get(statement.target);
      if (out === undefined && module.constValues.has(statement.target)) {
        // The checker already reports a module's own consts; this is the
        // imported one it could not see.
        diagnostics.push(diagnostic(
          Codes.ASSIGN_TO_CONST,
          `'${statement.target}' is a const — a compile-time value with no storage — and cannot be assigned`,
          module.file, statement.start ?? 0, statement.length ?? 0,
        ));
      } else if (out === undefined) {
        diagnostics.push(diagnostic(
          Codes.UNRESOLVED_NAME,
          `cannot find name '${statement.target}'`,
          module.file, statement.start ?? 0, statement.length ?? 0,
        ));
      } else if (isImportedName(module, scope, statement.target) && globalNamed(module, statement.target)?.stringCapacity) {
        // `name = ...` on an imported string<N>: a copy, as for an own one.
        const g = globalNamed(module, statement.target);
        statement.kind = 'stringCopy';
        statement.target = { kind: 'ref', name: statement.target, start: statement.start, length: statement.length };
        statement.source = statement.value;
        statement.capacity = g.stringCapacity;
        delete statement.value;
        rewriteStatement(statement, scope, module, diagnostics);
        return;
      } else if (isImportedName(module, scope, statement.target) && globalNamed(module, statement.target)?.array) {
        // An imported array; an own one was refused when the module lowered.
        diagnostics.push(diagnostic(
          Codes.NOT_COMPILABLE,
          `'${statement.target}' is an array: it is written one element at a time, ${statement.target}[i] = ...`,
          module.file, statement.start ?? 0, statement.length ?? 0,
        ));
      } else {
        statement.target = out;
      }
      rewriteExpression(statement.value, scope, module, diagnostics);
      if (statement.value.kind === 'string' && out !== undefined && !scope.bound?.has(statement.target)) {
        // A string const (own or imported, now inlined) into a number global.
        diagnostics.push(diagnostic(
          Codes.NOT_COMPILABLE,
          `'${statement.target}' is not a string: a string is assigned to a string<N>`,
          module.file, statement.value.start ?? 0, statement.value.length ?? 0,
        ));
      }
      return;
    }
    case 'storeIndex':
      if (isImportedName(module, scope, statement.array.name) && globalNamed(module, statement.array.name)?.stringCapacity) {
        diagnostics.push(diagnostic(
          Codes.NOT_COMPILABLE,
          `a string is assigned whole (${statement.array.name} = "..."), not one character at a time`,
          module.file, statement.start ?? 0, statement.length ?? 0,
        ));
        return;
      }
      rewriteArrayAccess(statement, scope, module, diagnostics, { store: true });
      rewriteExpression(statement.value, scope, module, diagnostics);
      return;
    case 'stringCopy': {
      // The source must be a string: a literal (checked against the
      // capacity here, where the program's string table is), a string
      // const, a parameter, or a string<N> — own or imported.
      const sourceName = statement.source.kind === 'ref' ? statement.source.name : null;
      if (sourceName !== null && !isStringName(module, scope, sourceName)) {
        diagnostics.push(diagnostic(
          Codes.NOT_COMPILABLE,
          `'${statement.target.name}' is a string<${statement.capacity}>: it is assigned a string — a literal, a const, a parameter, or another string variable`,
          module.file, statement.source.start ?? 0, statement.source.length ?? 0,
        ));
      }
      rewriteExpression(statement.target, scope, module, diagnostics);
      rewriteExpression(statement.source, scope, module, diagnostics);
      if (statement.source.kind === 'const') {
        diagnostics.push(diagnostic(
          Codes.NOT_COMPILABLE,
          `'${statement.target.name}' is a string<${statement.capacity}>: it is assigned a string, not a number`,
          module.file, statement.start ?? 0, statement.length ?? 0,
        ));
      }
      checkStringFits(statement.source, statement.capacity, module.program, module, diagnostics);
      return;
    }
    case 'call': {
      const out = scope.get(statement.name);
      if (out === undefined) {
        diagnostics.push(diagnostic(
          Codes.UNRESOLVED_NAME,
          `cannot find name '${statement.name}'`,
          module.file, statement.start ?? 0, statement.length ?? 0,
        ));
      } else {
        statement.original = statement.name;
        statement.name = out;
      }
      for (const argument of statement.args) rewriteExpression(argument, scope, module, diagnostics);
      if (out !== undefined) { completeCall(statement, module, diagnostics); delete statement.original; }
      return;
    }
    case 'namespaceCall':
      // Same shape whether reached as a statement or a subexpression —
      // `rewriteExpression`'s handling already mutates it in place.
      rewriteExpression(statement, scope, module, diagnostics);
      return;
    case 'memoryWrite':
      rewriteExpression(statement.address, scope, module, diagnostics);
      rewriteExpression(statement.value, scope, module, diagnostics);
      return;
    case 'memoryRead':
      // Only reachable as a bare statement (the read result discarded).
      rewriteExpression(statement.address, scope, module, diagnostics);
      return;
    case 'return':
      if (statement.value) rewriteExpression(statement.value, scope, module, diagnostics);
      return;
    case 'local':
      // The initializer is evaluated before the name exists (`let x = x`
      // reads the outer x, or nothing); then the local shadows.
      rewriteExpression(statement.init, scope, module, diagnostics);
      if (statement.init.kind === 'string') {
        diagnostics.push(diagnostic(
          Codes.NOT_COMPILABLE,
          `a string cannot initialize a ${statement.type}: a string lives in a string<N> or a const`,
          module.file, statement.init.start ?? 0, statement.init.length ?? 0,
        ));
      }
      bindLocal(scope, statement.name);
      return;
    case 'if': {
      rewriteExpression(statement.test, scope, module, diagnostics);
      const thenScope = childScope(scope);
      for (const s of statement.then) rewriteStatement(s, thenScope, module, diagnostics);
      const elseScope = childScope(scope);
      for (const s of statement.else ?? []) rewriteStatement(s, elseScope, module, diagnostics);
      return;
    }
    case 'while': {
      rewriteExpression(statement.test, scope, module, diagnostics);
      const inner = childScope(scope);
      for (const s of statement.body) rewriteStatement(s, inner, module, diagnostics);
      return;
    }
    case 'for': {
      // The initializer's local is in scope for the test, the update, and
      // the body, and gone after the loop.
      const inner = childScope(scope);
      if (statement.init) rewriteStatement(statement.init, inner, module, diagnostics);
      if (statement.test) rewriteExpression(statement.test, inner, module, diagnostics);
      if (statement.update) rewriteStatement(statement.update, inner, module, diagnostics);
      const bodyScope = childScope(inner);
      for (const s of statement.body) rewriteStatement(s, bodyScope, module, diagnostics);
      return;
    }
    case 'block': {
      const inner = childScope(scope);
      for (const s of statement.body) rewriteStatement(s, inner, module, diagnostics);
      return;
    }
    default: // 'break', 'continue' name nothing; 'asm' is opaque
  }
}

/**
 * The entry module's one export is the program.
 *
 * Exactly one thing may be exported from the entry module, it must be a
 * function, and it must take no parameters: that function is what the 6502
 * backend's synthesised C `main` calls and what the web host's worker calls,
 * bare. Any name is fine (`main` is the convention, not a rule). Other
 * modules — packages, libraries — export whatever they like; this rule is
 * about the file a build starts from.
 *
 * @returns {{ name: string|null, diagnostics: object[] }} the entry
 *   function's source name (null when the rule failed).
 */
function checkEntryExports(module) {
  const diagnostics = [];
  const at = (item, message) => diagnostics.push(diagnostic(
    Codes.ENTRY_EXPORTS, message, module.file, item.start ?? 0, item.length ?? 0,
  ));

  const functions = module.ir.functions.filter((fn) => fn.exported);
  const globals = [
    ...module.ir.globals.filter((g) => g.exported),
    ...(module.ir.consts ?? []).filter((c) => c.exported),
  ];
  const namespaces = (module.ir.namespaces ?? []).filter((ns) => ns.exported);

  for (const g of globals) {
    at(g, `the entry module may export only its entry function; '${g.name}' is a global`);
  }
  for (const ns of namespaces) {
    at(ns, `the entry module may export only its entry function; '${ns.name}' is a namespace`);
  }
  if (functions.length === 0) {
    if (globals.length === 0 && namespaces.length === 0) {
      at({}, 'the entry module exports nothing; export exactly one function to be the program');
    } else {
      at({}, 'the entry module exports no function; export exactly one to be the program');
    }
    return { name: null, diagnostics };
  }
  if (functions.length > 1) {
    for (const fn of functions) {
      at(fn, `the entry module must export exactly one function, its entry point; '${fn.name}' is one of ${functions.length}`);
    }
    return { name: null, diagnostics };
  }
  const [entry] = functions;
  if (entry.params.length > 0) {
    at(entry, `the entry point '${entry.name}' must take no parameters`);
    return { name: null, diagnostics };
  }
  return { name: diagnostics.length === 0 ? entry.name : null, diagnostics };
}

/**
 * Link a program from its entry module.
 *
 * The full front end runs over every module in the graph, so the diagnostics
 * returned cover all of them — the `sources` map carries each file's text for
 * rendering positions. `ir` is null whenever there are diagnostics: a program
 * with any error in any module is not linked. The linked IR carries `entry`,
 * the output name of the entry module's one exported function (see
 * checkEntryExports).
 *
 * @param {string} entryText  The entry module's source.
 * @param {string} entryFile  Its absolute path, the root imports resolve from.
 * @param {{ machine?: string, tags?: string[], profile?: string, frameRate?: number, facts?: object }} [options]
 *   `machine` is the target being built for; packages with target-
 *   conditional entries resolve to that machine's implementation, and any
 *   `.8bs` file with a `.<machine>.8bs` twin beside it resolves to the
 *   twin. `tags` are the hardware tags the build carries (an 8032 PET, an
 *   expanded VIC-20): a `.<machine>.<tag>.8bs` twin is taken before the
 *   machine's own, and two tags each with a twin is `8BS3004`. The older
 *   `profile` is accepted as one tag. `frameRate` (default 60) is the
 *   project's logical frame rate — see 8bs.config.ts — that every
 *   `#frames(...)` call in the graph folds against; `machine` is also what
 *   every `#system()` call folds to. `facts` is the build's hardware fact
 *   sheet (the merged `facts` of packages/cli/src/hardware.mjs's
 *   resolveHardware), what every `#fact(...)` folds from; a build that
 *   names a machine and reads a fact without one is `8BS1038`.
 * @returns {{ ir: object|null, diagnostics: object[], sources: Map<string,string> }}
 */
export function link(entryText, entryFile, options = {}) {
  const diagnostics = [];
  const sources = new Map();

  const { modules, nativeSources } = loadGraph(entryText, entryFile, diagnostics, sources, options);
  // modules[0] is the entry: loadGraph enqueues it before walking imports.
  const entry = checkEntryExports(modules[0]);
  diagnostics.push(...entry.diagnostics);
  bindImports(modules, diagnostics);
  if (diagnostics.length > 0) return { ir: null, diagnostics, sources };

  assignOutputNames(modules);
  resolvePendingConsts(modules, diagnostics);
  if (diagnostics.length > 0) return { ir: null, diagnostics, sources };

  // `nativeSources` is not IR the backends translate — it is the list of
  // files a backend passes through untouched (the 6502 backend receives
  // them as native sources and does not yet emit a binary; the web backend
  // has no use for 6502 assembly or CHR data and ignores it).
  const ir = {
    imports: [], globals: [], functions: [], strings: [], nativeSources,
    entry: modules[0].rename.get(entry.name),
  };
  for (const module of modules) {
    // One string table for the program, deduplicated across modules by
    // content — "TICK" in two modules is one constant. `stringMap` takes a
    // module's slot number to the program's. Every module's table first: a
    // string const is imported by its slot, and the importer may come
    // before the module that declares it.
    module.stringMap = (module.ir.strings ?? []).map((s) => {
      let index = ir.strings.findIndex((t) => t.text === s.text);
      if (index === -1) { index = ir.strings.length; ir.strings.push(s); }
      return index;
    });
    module.program = ir;
    for (const [name, value] of module.ownConsts) {
      if (typeof value === 'object') module.ownConsts.set(name, { string: module.stringMap[value.string] });
    }
  }
  for (const module of modules) {
    const scope = new Map(module.rename);
    // Consts are inlined, not renamed: this module's own plus every import
    // that names another module's const.
    module.constValues = new Map(module.ownConsts);
    for (const [local, binding] of module.bindings) {
      if (binding.module.ownConsts.has(binding.name)) {
        module.constValues.set(local, binding.module.ownConsts.get(binding.name));
        continue;
      }
      scope.set(local, binding.module.rename.get(binding.name));
    }
    module.scope = scope;
  }
  // Every function's parameter defaults, resolved, and every function by
  // its output name — before any body is rewritten, since a call in one
  // module is completed from the parameters of a function in another.
  ir.functionsByOutput = new Map();
  const functionFiles = new Map(); // each linked function to its module's file, for checkHardwareHazards
  for (const module of modules) {
    for (const fn of module.ir.functions) {
      for (const param of fn.params) {
        if (param.default === undefined) continue;
        if (param.default.kind === 'string') {
          param.default = { kind: 'string', index: module.stringMap[param.default.index] };
        } else if (param.default.kind !== 'const') {
          param.default = { kind: 'const', value: resolveInitialiser(param.default, { type: param.type }, module.scope, module, diagnostics) };
        }
      }
      ir.functionsByOutput.set(module.rename.get(fn.name), fn);
    }
  }
  for (const module of modules) {
    const { scope } = module;
    for (const g of module.ir.globals) {
      // An initializer lowering left pending is a bare name or a
      // namespace const: an imported const or `BorderColor.BLUE` is its
      // value, and anything else cannot initialize a global — there is no
      // code to run before the program starts. An array's pending
      // elements are resolved the same way, one at a time.
      if (Array.isArray(g.init)) {
        g.init = g.init.map((element) => (typeof element === 'object'
          ? resolveInitialiser(element, g, scope, module, diagnostics) : element));
      } else if (g.init !== null && typeof g.init === 'object' && g.init.kind === 'namespaceConst') {
        g.init = resolveInitialiser(g.init, g, scope, module, diagnostics);
      } else if (g.init !== null && typeof g.init === 'object') {
        const { name, start, length } = g.init;
        if (typeof module.constValues.get(name) === 'object') {
          diagnostics.push(diagnostic(
            Codes.NOT_COMPILABLE, `'${name}' is a string const; it cannot initialize a ${g.type}`,
            module.file, start ?? 0, length ?? 0,
          ));
          g.init = 0;
        } else if (module.constValues.has(name)) {
          g.init = module.constValues.get(name);
        } else {
          diagnostics.push(diagnostic(
            scope.has(name) ? Codes.NOT_COMPILABLE : Codes.UNRESOLVED_NAME,
            scope.has(name)
              ? `'${name}' is not a const, so it cannot initialize a global: an initializer is a literal or a const`
              : `cannot find name '${name}'`,
            module.file, start ?? 0, length ?? 0,
          ));
          g.init = 0;
        }
      }
      g.name = module.rename.get(g.name);
      ir.globals.push(g);
    }
    for (const fn of module.ir.functions) {
      fn.name = module.rename.get(fn.name);
      // A parameter is never renamed and always shadows a same-named global
      // or import within its own function — ordinary lexical scoping, not a
      // collision the way two modules' globals can collide.
      const fnScope = childScope(scope);
      for (const param of fn.params) bindLocal(fnScope, param.name);
      for (const statement of fn.body) rewriteStatement(statement, fnScope, module, diagnostics);
      ir.functions.push(fn);
      functionFiles.set(fn, module.file);
    }
  }

  if (diagnostics.length > 0) return { ir: null, diagnostics, sources };
  // After every body is rewritten — consts inlined, globals under their
  // output names — the writes the target refuses are visible as what they
  // are, whichever module spelled them and however it named the address.
  checkHardwareHazards(ir, options.machine, functionFiles, diagnostics);
  if (diagnostics.length > 0) return { ir: null, diagnostics, sources };
  ir.memory = memoryOf(ir);
  return { ir, diagnostics, sources };
}

/**
 * What the program declares, in bytes: `variables` is RAM (every `let`,
 * arrays and `string<N>` included, at the size of its type; not an
 * `@address`, which names hardware, and not a const array, which is
 * data), `data` is constant program data (string literals with their
 * length byte, const arrays). Declared, not measured: a target's
 * toolchain may still drop a variable nothing reads, so the 6502 backend
 * reports what the linked program actually holds when it can.
 *
 * @returns {{ variables: number, data: number }}
 */
export function memoryOf(ir) {
  let variables = 0;
  let data = 0;
  for (const g of ir.globals) {
    if (g.address !== null) continue;
    const bytes = storageBytes(g.type) * (g.array ?? 1);
    if (g.constant) data += bytes;
    else variables += bytes;
  }
  for (const s of ir.strings ?? []) data += 1 + s.bytes.length;
  return { variables, data };
}
