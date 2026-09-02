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
// Two deliberate absences, on record:
//   - No reachability pruning. Every module's globals and functions are
//     emitted whether used or not. Hardware registers are #defines and cost
//     nothing; on a 3583-byte VIC-20 unused *code* will eventually matter, and
//     pruning earns its place when a package ships more than registers.
//   - asm6502 text is never rewritten. Inline assembly that names a symbol
//     sees the symbol's final, possibly-suffixed name — packages that ship
//     assembly should prefer names unlikely to collide.
import { readFileSync, realpathSync } from 'node:fs';

import { tokenize } from '../lexer/index.mjs';
import { parse } from '../parser/index.mjs';
import { check } from '../checker/index.mjs';
import { lower } from '../ir/index.mjs';
import { resolveSpecifier } from '../resolver/index.mjs';
import { Codes, diagnostic } from '../diagnostics/index.mjs';

/** The canonical identity of a file: two pnpm symlink routes, one module. */
function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Run the pure front end over one module's text. */
function loadModule(file, text, diagnostics) {
  const { tokens, diagnostics: lexical } = tokenize(text, file);
  const { ast, diagnostics: syntax } = parse(tokens, text, file);
  diagnostics.push(...lexical, ...syntax, ...check(ast, file));
  const { ir, diagnostics: lowering } = lower(ast, file);
  diagnostics.push(...lowering);
  return { file, ir };
}

/**
 * Discover and load every module reachable from the entry.
 *
 * Cycles are permitted: a module already loaded is bound to, not reloaded.
 * Globals initialise to literals only, so no initialisation-order problem
 * exists for a cycle to cause.
 */
function loadGraph(entryText, entryFile, diagnostics, sources, options) {
  const modules = [];
  const byPath = new Map();

  const enqueue = (file, text) => {
    const module = loadModule(file, text, diagnostics);
    modules.push(module);
    byPath.set(canonical(file), module);
    sources.set(file, text);
    return module;
  };

  enqueue(entryFile, entryText);

  // modules grows while we walk it: a plain index loop is the worklist.
  for (let i = 0; i < modules.length; i += 1) {
    const module = modules[i];
    for (const imp of module.ir.imports) {
      const resolved = resolveSpecifier(imp.source, module.file, options);
      if (!resolved) {
        diagnostics.push(diagnostic(
          Codes.NOT_COMPILABLE,
          `import specifier '${imp.source}' is not linkable yet: only './file.8bs' paths and bare package names are specified`,
          module.file, imp.start, imp.length,
        ));
        continue;
      }
      if (resolved.code) {
        diagnostics.push(diagnostic(resolved.code, resolved.message, module.file, imp.start, imp.length));
        continue;
      }
      if (resolved.path === null) {
        // A conditional package entry with no machine to choose by: the
        // caller linked without one, and guessing a machine would be worse.
        diagnostics.push(diagnostic(
          Codes.NOT_COMPILABLE,
          `'${imp.source}' has a target-conditional entry; linking it needs a machine target`,
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
    }
  }

  return modules;
}

/** Every top-level name a module declares, mapped to whether it is exported. */
function declarationsOf(module) {
  const decls = new Map();
  for (const g of module.ir.globals) decls.set(g.name, g.exported);
  for (const f of module.ir.functions) decls.set(f.name, f.exported);
  return decls;
}

/**
 * Check import bindings: every imported name must be exported by the module
 * its specifier resolved to, and must not collide with a declaration or
 * another import in the importing module.
 */
function bindImports(modules, diagnostics) {
  for (const module of modules) {
    module.decls = declarationsOf(module);
    module.bindings = new Map();
  }
  for (const module of modules) {
    for (const imp of module.ir.imports) {
      if (!imp.module) continue; // resolution already failed and reported
      for (const spec of imp.specifiers) {
        if (module.decls.has(spec.local) || module.bindings.has(spec.local)) {
          diagnostics.push(diagnostic(
            Codes.DUPLICATE_BINDING,
            `'${spec.local}' is already bound in this module`,
            module.file, spec.start, spec.length,
          ));
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
 * Give every declaration its output name. First come keeps the source name;
 * the entry module comes first, so user-facing names — `main` above all —
 * never change. Later modules take `name_2`, `name_3`, … on collision.
 */
function assignOutputNames(modules) {
  const taken = new Set();
  for (const module of modules) {
    module.rename = new Map();
    for (const name of module.decls.keys()) {
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
      return;
    case 'unop':
      rewriteExpression(expr.argument, scope, module, diagnostics);
      return;
    case 'call': {
      const out = scope.get(expr.name);
      if (out === undefined) {
        diagnostics.push(diagnostic(
          Codes.UNRESOLVED_NAME,
          `cannot find name '${expr.name}'`,
          module.file, expr.start ?? 0, expr.length ?? 0,
        ));
      } else {
        expr.name = out;
      }
      for (const argument of expr.args) rewriteExpression(argument, scope, module, diagnostics);
      return;
    }
    case 'memoryRead':
      // `memory` names nothing to resolve — it is a compiler intrinsic, not
      // an import — but its address argument can still reference a global.
      rewriteExpression(expr.address, scope, module, diagnostics);
      return;
    default: // 'const' names nothing
  }
}

function rewriteStatement(statement, scope, module, diagnostics) {
  switch (statement.kind) {
    case 'assign': {
      const out = scope.get(statement.target);
      if (out === undefined) {
        diagnostics.push(diagnostic(
          Codes.UNRESOLVED_NAME,
          `cannot find name '${statement.target}'`,
          module.file, statement.start ?? 0, statement.length ?? 0,
        ));
      } else {
        statement.target = out;
      }
      rewriteExpression(statement.value, scope, module, diagnostics);
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
        statement.name = out;
      }
      for (const argument of statement.args) rewriteExpression(argument, scope, module, diagnostics);
      return;
    }
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
    case 'if':
      rewriteExpression(statement.test, scope, module, diagnostics);
      for (const s of statement.then) rewriteStatement(s, scope, module, diagnostics);
      for (const s of statement.else ?? []) rewriteStatement(s, scope, module, diagnostics);
      return;
    case 'while':
      rewriteExpression(statement.test, scope, module, diagnostics);
      for (const s of statement.body) rewriteStatement(s, scope, module, diagnostics);
      return;
    case 'block':
      for (const s of statement.body) rewriteStatement(s, scope, module, diagnostics);
      return;
    default: // 'break', 'continue' name nothing; 'asm' is opaque
  }
}

/**
 * Link a program from its entry module.
 *
 * The full front end runs over every module in the graph, so the diagnostics
 * returned cover all of them — the `sources` map carries each file's text for
 * rendering positions. `ir` is null whenever there are diagnostics: a program
 * with any error in any module is not linked.
 *
 * @param {string} entryText  The entry module's source.
 * @param {string} entryFile  Its absolute path, the root imports resolve from.
 * @param {{ machine?: 'vic20'|'c64'|'web' }} [options]
 *   The machine being built for; packages with target-conditional entries
 *   resolve to that machine's implementation.
 * @returns {{ ir: object|null, diagnostics: object[], sources: Map<string,string> }}
 */
export function link(entryText, entryFile, options = {}) {
  const diagnostics = [];
  const sources = new Map();

  const modules = loadGraph(entryText, entryFile, diagnostics, sources, options);
  bindImports(modules, diagnostics);
  if (diagnostics.length > 0) return { ir: null, diagnostics, sources };

  assignOutputNames(modules);

  const ir = { imports: [], globals: [], functions: [] };
  for (const module of modules) {
    const scope = new Map(module.rename);
    for (const [local, binding] of module.bindings) {
      scope.set(local, binding.module.rename.get(binding.name));
    }
    for (const g of module.ir.globals) {
      g.name = module.rename.get(g.name);
      ir.globals.push(g);
    }
    for (const fn of module.ir.functions) {
      fn.name = module.rename.get(fn.name);
      // A parameter is never renamed and always shadows a same-named global
      // or import within its own function — ordinary lexical scoping, not a
      // collision the way two modules' globals can collide.
      const fnScope = fn.params.length > 0 ? new Map(scope) : scope;
      for (const param of fn.params) fnScope.set(param.name, param.name);
      for (const statement of fn.body) rewriteStatement(statement, fnScope, module, diagnostics);
      ir.functions.push(fn);
    }
  }

  if (diagnostics.length > 0) return { ir: null, diagnostics, sources };
  return { ir, diagnostics, sources };
}
