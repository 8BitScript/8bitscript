// Regenerates fixtures/variants.json: the variant functions of resolver/index.mjs over a temp tree
// with machine, tag and locale twins, from the JS. `chooseVariant` and `chooseModule` are not exported,
// so they are read through a throwaway copy of the module with an extra export line (deleted afterwards;
// the JS source itself is not touched).
// Run from the repo root: node crates/resolver/tests/gen/variants.mjs
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcDir = fileURLToPath(new URL('../../../../packages/compiler/src/resolver/', import.meta.url));
const probe = join(srcDir, `.variants-probe-${process.pid}.mjs`);
writeFileSync(probe, `${readFileSync(join(srcDir, 'index.mjs'), 'utf8')}\nexport { chooseVariant, chooseModule };\n`);
let js;
try {
  js = await import(pathToFileURL(probe).href);
} finally {
  rmSync(probe);
}
const {
  MACHINES, RELEASE_MACHINES, isReleaseMachine, variantOf, tagsOf, isVariantPath, machineOfVariant,
  variantsPresent, chooseVariant, chooseModule,
} = js;

const root = mkdtempSync(join(tmpdir(), 'resolver-variants-'));
const files = [
  'a/geo.8bs',
  'b/m.8bs', 'b/m.pet.8bs', 'b/m.c64.8bs',
  'c/t.8bs', 'c/t.pet.8bs', 'c/t.pet.8032.8bs', 'c/t.pet.expanded.8bs',
  'd/l.8bs', 'd/l.de.8bs', 'd/l.pet.8bs', 'd/l.c64.8bs', 'd/l.c64.de.8bs',
  'd/k.pet.8bs', 'd/k.de.8bs',
  'e/o.nes.8bs', 'e/o.pet.8032.8bs', 'e/o.de.8bs', 'e/o.c64.8bs',
  'f/p.8bs', 'f/p.pet.8bs', 'f/p.pet.de.8bs', 'f/p.pet.8032.8bs', 'f/p.pet.8032.de.8bs', 'f/p.de.8bs', 'f/p.fr.8bs',
  'g/x.8bs', 'g/x.8bx', 'g/y.8bx', 'g/y.pet.8bx', 'g/z.8bg', 'g/z.pet.8bg', 'g/z.8ba', 'g/w.8bs', 'g/w.pet.8bs',
  'h/q.8bs', 'h/q.data.8bs', 'h/q.pet.a.b.8bs', 'h/q.pet.-x.8bs', 'h/q.pet.8032.de-ch.8bs', 'h/q.pet.8032.Xx.8bs',
  'h/q.pet.8032.de.fr.8bs', 'h/q.Pet.8bs', 'h/q.de-ch.8bs', 'h/q.zh-hans.8bs', 'h/q.d.8bs', 'h/q..8bs', 'h/q.8bs.bak',
  'h/qq.pet.8bs', 'h/q.pet.8bx',
  'i/é.pet.8bs', 'i/é.8bs',
  'j/only.de.8bs', 'j/only.fr.8bs', 'j/only.pet.8bs',
  'k/w.8bs', 'k/w.pet.8bs', 'k/w.pet.8032.8bs', 'k/w.pet.expanded.8bs', 'k/w.pet.de.8bs', 'k/w.pet.8032.de.8bs',
  'k/w.c64.8bs', 'k/w.c64.hires.8bs', 'k/w.c64.de.8bs',
  'l/n.pet.8bs', 'l/n.pet.8032.8bs', 'l/n.pet.expanded.8bs',
];
for (const file of files) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), '');
}
mkdirSync(join(root, 'dir.8bs'));

const rel = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.path === 'string') {
    return { ...value, path: relative(root, value.path) };
  }
  return value;
};
const rows = [];
const add = (fn, args, result) => rows.push({ fn, args, result });

add('MACHINES', [], [...MACHINES]);
add('RELEASE_MACHINES', [], [...RELEASE_MACHINES]);
for (const m of [...MACHINES, 'nope', '', 'PET']) add('isReleaseMachine', [m], isReleaseMachine(m));

const paths = ['x/main.8bs', 'x/main.8bx', 'x/main.8bg', 'x/main.8ba', 'x/main', 'x/main.txt', 'main.8bs', '/abs/p.8bs', 'x/a.b.8bs', 'x/é.8bs'];
for (const p of paths) {
  for (const [m, t, l] of [['pet'], ['nes'], ['pet', '8032'], ['pet', '8032', 'de'], ['pet', undefined, 'de'], [undefined, undefined, 'de'],
    ['', 't'], ['pet', null], [null, null, 'fr'], ['c64', '', 'de']]) {
    add('variantOf', [p, m ?? null, t ?? null, l ?? null], variantOf(p, m, t, l));
  }
}
add('variantOf', ['x/main.8bs'], variantOf('x/main.8bs'));

const optionCases = [{}, { tags: ['a', 'b'] }, { tags: [] }, { profile: '8032' }, { profile: '' }, { tags: 'x', profile: 'p' },
  { tags: ['t'], profile: 'p' }, { tags: null, profile: 'p' }, { machine: 'pet' }, { tags: 5 }];
for (const o of optionCases) add('tagsOf', [o], tagsOf(o));
add('tagsOf', [{ $undefined: true }], tagsOf());

const variantPaths = [];
for (const base of ['x', 'x.pet', 'x.pet.8032', 'x.nes', 'x.data', 'foo.io', 'x.de', 'x.pet.de', 'x.pet.8032.de', 'x.pet.a.b', 'x.Pet', 'x.pet.', 'x.pet..x',
  'x.8032.pet', 'pet', '.pet', 'x.fr', 'x.pet.-', 'x.c64.hires', 'x.zh-hans', 'x.pet.8032.8bs', 'a.mega65', 'a.atari8.on', 'a.atari8.on.de']) {
  for (const ext of ['.8bs', '.8bx', '.8bg', '.8ba', '.txt', '']) variantPaths.push(`d/${base}${ext}`);
}
for (const p of variantPaths) {
  for (const l of [undefined, 'de', 'fr', '', 'pet', 'de-ch']) add('isVariantPath', [p, l ?? null], isVariantPath(p, l));
  add('machineOfVariant', [p], machineOfVariant(p));
}
add('isVariantPath', ['d/x.pet.8bs'], isVariantPath('d/x.pet.8bs'));

const treePaths = files.map((f) => f).concat(['a/geo.pet.8bs', 'a/geo.8bx', 'a/geo.8bg', 'a/geo', 'a/missing.8bs', 'zz/none.8bs', 'dir.8bs', 'dir', 'h/q', 'h/q.pet.8bs', 'h/q.8bx', 'i/é.8bs', 'j/only.8bs', 'j/only']);
for (const p of treePaths) add('variantsPresent', [p], variantsPresent(join(root, p)));

const tagSets = [[], ['8032'], ['8032', 'expanded'], ['hires'], ['']];
const machines = [undefined, 'pet', 'c64', 'nes'];
const locales = [undefined, 'de', 'fr'];
const bases = ['a/geo.8bs', 'a/nothing.8bs', 'b/m.8bs', 'c/t.8bs', 'd/l.8bs', 'd/k.8bs', 'e/o.8bs', 'f/p.8bs', 'f/p.pet.8bs', 'f/p.de.8bs', 'f/p.pet.8032.8bs',
  'g/x.8bx', 'g/y.8bx', 'g/z.8bg', 'k/w.8bs', 'k/w.pet.8bs', 'l/n.8bs', 'j/only.8bs', 'i/\u00e9.8bs', 'h/q.8bs', 'h/q.pet.8bs', 'dir.8bs', 'zz/none.8bs'];
for (const base of bases) {
  for (const machine of machines) {
    for (const tags of tagSets) {
      for (const locale of locales) {
        const args = [`./${base}`, base, machine ?? null, tags, locale ?? null];
        const result = chooseVariant(args[0], join(root, base), machine, tags, locale);
        add('chooseVariant', args, rel(result));
      }
    }
  }
}
// tags omitted: the default `[]`.
for (const base of ['b/m.8bs', 'c/t.8bs', 'e/o.8bs']) {
  for (const machine of ['pet', undefined]) add('chooseVariant', ['s', base, machine ?? null, { $undefined: true }, null], rel(chooseVariant('s', join(root, base), machine, undefined, undefined)));
}

const moduleTargets = ['a/geo', 'a/geo.8bs', 'g/x', 'g/y', 'g/z', 'g/w', 'b/m', 'c/t', 'd/l', 'e/o', 'f/p', 'k/w', 'l/n', 'h/q', 'zz/none', 'g/x.8bx', 'j/only', 'i/é', 'dir'];
const optionSets = [
  {}, { pathForm: true }, { machine: 'pet' }, { machine: 'pet', pathForm: true }, { machine: 'c64', pathForm: true },
  { machine: 'pet', tags: ['8032'], pathForm: true }, { machine: 'pet', tags: ['8032', 'expanded'], pathForm: true },
  { machine: 'pet', locale: 'de', pathForm: true }, { locale: 'de', pathForm: true }, { machine: 'nes', pathForm: true },
  { machine: 'pet', profile: '8032' }, { machine: 'pet', profile: '8032', pathForm: true }, { machine: 'c64', locale: 'de' },
];
for (const target of moduleTargets) {
  for (const options of optionSets) {
    add('chooseModule', [`./${target}`, target, options], rel(chooseModule(`./${target}`, join(root, target), options)));
  }
}
rmSync(root, { recursive: true });

const tree = Object.fromEntries(files.map((f) => [f, '']));
const out = fileURLToPath(new URL('../fixtures/variants.json', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `{\n"tree": ${JSON.stringify(tree)},\n"dirs": ["dir.8bs"],\n"rows": [\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]\n}\n`);
console.log(`${rows.length} rows -> ${out}`);
