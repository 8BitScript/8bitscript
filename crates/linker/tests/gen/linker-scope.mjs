// Regenerates crates/linker/tests/fixtures/<tree>/golden from the JS oracle: the linker's scope,
// const and import passes (packages/compiler/src/linker/index.mjs:260-682).
// Run from the repo root: node crates/linker/tests/gen/linker-scope.mjs
//
// Most of the passes are module-private, so the script copies index.mjs next to the original
// with one `export` line appended, imports the copy and deletes it. index.mjs is never edited.
// Each tree is copied to a scratch directory, linked with the machine c64 and the repo root as
// checkout, and written with the scratch as <project> and the repo as <toolchain>.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalJson } from '../../../../packages/cli/src/stage-dump.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = realpathSync(join(here, '..', '..', '..', '..'));
const linkerDir = join(repo, 'packages', 'compiler', 'src', 'linker');
const copy = join(linkerDir, '.index-export-for-fixtures.mjs');
const names = [
  'loadGraph', 'testedFacts', 'bindImports', 'assignOutputNames', 'visibleConsts', 'resolveNamespaceMember',
  'globalNamed', 'isImportedName', 'isStringName', 'constExpression', 'checkStringFits', 'completeCall',
  'childScope', 'bindLocal',
];
writeFileSync(copy, `${readFileSync(join(linkerDir, 'index.mjs'), 'utf8')}\nexport { ${names.join(', ')} };\n`);
let m;
try {
  m = await import(pathToFileURL(copy).href);
} finally {
  rmSync(copy, { force: true });
}

const pairs = (map) => [...map];
const hasError = (diagnostics) => diagnostics.some((d) => d.severity !== 'warning');

// Every `call` node in a value, in visit order.
function calls(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) calls(item, out);
  } else if (value && typeof value === 'object') {
    if (value.kind === 'call' && Array.isArray(value.args) && typeof value.name === 'string') out.push(value);
    for (const key of Object.keys(value)) calls(value[key], out);
  }
  return out;
}

function generate(tree) {
  const fixture = join(here, '..', 'fixtures', tree);
  const golden = join(fixture, 'golden');
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `linker-scope-${tree}-`)));
  try {
    cpSync(join(fixture, 'src'), scratch, { recursive: true });
    const roots = { toolchain: [repo], project: [scratch] };
    const entry = join(scratch, 'main.8bs');
    const diagnostics = [];
    const options = { machine: 'c64', frameRate: 60, facts: {}, checkout: repo };
    const { modules, nativeSources } = m.loadGraph(readFileSync(entry, 'utf8'), entry, diagnostics, new Map(), options);
    const at = (module) => modules.indexOf(module);
    const out = {};
    out['natives.json'] = nativeSources;
    out['imports.json'] = {
      modules: modules.map((module) => module.file),
      imports: modules.map((module) => module.ir.imports.map((imp) => (imp.module ? at(imp.module) : null))),
    };
    out['facts.json'] = m.testedFacts(modules);

    m.bindImports(modules, diagnostics);
    const binding = (b) => ({ module: at(b.module), name: b.name });
    out['bind.json'] = {
      modules: modules.map((module) => ({
        decls: pairs(module.decls),
        globalsByName: [...module.globalsByName.keys()],
        namespaces: [...module.namespaces.keys()],
        ownConsts: pairs(module.ownConsts),
        ownConstTypes: pairs(module.ownConstTypes),
        bindings: pairs(module.bindings).map(([k, b]) => [k, binding(b)]),
        namespaceBindings: pairs(module.namespaceBindings).map(([k, b]) => [k, binding(b)]),
      })),
      diagnostics,
    };
    const errored = hasError(diagnostics);
    if (!errored) {
      m.assignOutputNames(modules);
      out['rename.json'] = modules.map((module) => pairs(module.rename));
    }
    const visible = (module, options) => {
      const { values, types } = m.visibleConsts(module, options);
      return { values: pairs(values), types: pairs(types) };
    };
    out['visible.json'] = modules.map((module) => ({ all: visible(module), settled: visible(module, { settledOnly: true }) }));

    // The rows: constValues is what resolvePendingConsts leaves on a module; stand in for it.
    for (const module of modules) ({ values: module.constValues, types: module.constTypes } = m.visibleConsts(module));
    const rows = [];
    const row = (fn, args, result) => rows.push({ fn, args, result });
    modules.forEach((module, mi) => {
      const spaces = [...new Set([...module.namespaces.keys(), ...module.namespaceBindings.keys(), '__none'])];
      for (const ns of spaces) {
        const own = module.namespaces.get(ns);
        const bound = module.namespaceBindings.get(ns);
        const target = own ?? bound?.module.namespaces.get(bound.name);
        for (const table of ['functions', 'consts']) {
          const members = [...(target ? [...target.functions.keys(), ...target.consts.keys()] : []), '__missing'];
          for (const member of [...new Set(members)]) {
            const r = m.resolveNamespaceMember(module, ns, member, table);
            row('resolveNamespaceMember', [mi, ns, member, table], { ...r, targetModule: r.targetModule ? at(r.targetModule) : undefined });
          }
        }
      }
    });
    modules.forEach((module, mi) => {
      const scope = m.childScope(new Map(module.rename ?? []));
      m.bindLocal(scope, 'p');
      const ids = [...module.decls.keys(), ...module.bindings.keys(), 'p', '__missing'];
      for (const id of ids) {
        row('globalNamed', [mi, id], m.globalNamed(module, id));
        row('isImportedName', [mi, id], m.isImportedName(module, scope, id));
        row('isStringName', [mi, id], m.isStringName(module, scope, id));
      }
    });
    modules.forEach((module, mi) => {
      for (const [name, value] of module.ownConsts) {
        if (value?.pending) continue; // a pending value has no expression until it settles
        const type = module.ownConstTypes.get(name);
        row('constExpression', [value, type ?? null], m.constExpression(value, type));
      }
    });
    modules.forEach((module, mi) => {
      module.ir.strings.forEach((_, slot) => {
        const found = [];
        m.checkStringFits({ kind: 'string', index: slot }, 4, module.ir, module, found);
        row('checkStringFits', [mi, slot, 4], found);
      });
    });
    if (!errored) {
      const functionsByOutput = new Map();
      for (const module of modules) for (const f of module.ir.functions) functionsByOutput.set(module.rename.get(f.name), f);
      const complete = [];
      modules.forEach((module, mi) => {
        module.program = { functionsByOutput };
        for (const f of module.ir.functions) {
          for (const call of calls(f.body)) {
            for (const args of [call.args, [], [...call.args, ...call.args, ...call.args]]) {
              const input = structuredClone({ ...call, args });
              const found = [];
              const done = structuredClone(input);
              m.completeCall(done, module, found);
              complete.push({ fn: 'completeCall', args: [mi, input], result: { call: done, diagnostics: found } });
            }
          }
        }
      });
      // Order by the canonical text of the arguments: Rust finds the calls in another key order.
      complete.sort((a, b) => {
        const x = canonicalJson(a.args);
        const y = canonicalJson(b.args);
        return x < y ? -1 : x > y ? 1 : 0;
      });
      rows.push(...complete);
    }
    out['rows.json'] = rows;

    rmSync(golden, { recursive: true, force: true });
    mkdirSync(golden, { recursive: true });
    for (const [file, value] of Object.entries(out)) writeFileSync(join(golden, file), canonicalJson(value, roots));
    process.stdout.write(`${tree}: ${modules.length} modules, ${rows.length} rows, ${Object.keys(out).length} files${errored ? ' (errors)' : ''}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const trees = readdirSync(join(here, '..', 'fixtures')).filter((n) => !n.endsWith('.json')).sort();
for (const tree of trees) generate(tree);
