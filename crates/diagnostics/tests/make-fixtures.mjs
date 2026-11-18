// Regenerates fixtures.json, the Node-made expectations the diagnostics tests
// read. Run from the repo root: node crates/diagnostics/tests/make-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Codes, diagnostic, positionAt } from '../../../packages/compiler/src/diagnostics/index.mjs';
import {
  CPU_FAMILY, MACHINES, SOURCE_EXTENSIONS, cpuFamily, isLocaleName, isSourceFile,
  sourceKindOf, stripSourceExtension,
} from '../../../packages/compiler/src/source/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const diagnostics = [
  diagnostic(Codes.UNTERMINATED_STRING, 'unterminated string literal', 'a.8bs', 4, 9),
  diagnostic(Codes.SYNTAX_ERROR, "expected ';', found end of file", 'dir/b.8bx', 0, 0, 'error'),
  diagnostic(Codes.LOCALE_FALLBACK, 'no `de` twin — using plain file', 'c.8bs', 12, 3, 'warning'),
  diagnostic(Codes.LOOP_UNROLLED, 'unrolled 8 iterations', 'd.8bs', 1, 40, 'remark'),
];

const texts = ['', 'a', 'a\nb', 'one\ntwo\nthree', '\n\n', '\u{1F600}\nx', 'café\r\nx\n'];
const positions = [];
for (const text of texts) {
  for (let offset = 0; offset <= text.length + 2; offset += 1) {
    positions.push({ text, offset, ...positionAt(text, offset) });
  }
}

const paths = [
  'a.8bs', 'dir/b.8bx', 'c.8bg', 'd.8ba', 'main.c64.8bs', 'x.8bs.bak', '8bs', '.8bs', 'a.8bsx',
  'noext', '', 'dots.in.name.8bx', 'café.8bs', '.8bg.8ba', 'a.8BS',
];
const sourceKinds = paths.map((p) => ({
  path: p, kind: sourceKindOf(p), isSource: isSourceFile(p), stripped: stripSourceExtension(p),
}));

const locales = [
  'de', 'en', 'pt-br', 'zh-hans', 'nl', 'c64', 'pet', 'web', 'a', 'abcdefghi', 'DE', 'de-', '-de',
  'de-x', 'de-abcdefghi', 'de-ab-cd', 'de-1a', 'en-us1', 'vic20', 'de\n', 'gb', 'msx', 'sms',
];
const localeNames = locales.map((n) => ({ name: n, isLocale: isLocaleName(n) }));

const out = {
  codes: Object.entries(Codes),
  diagnostics,
  positions,
  sourceExtensions: [...SOURCE_EXTENSIONS],
  sourceKinds,
  machines: [...MACHINES],
  cpuFamily: Object.entries(CPU_FAMILY),
  cpuFamilyLookups: [...MACHINES, 'unknown', ''].map((m) => [m, cpuFamily(m)]),
  localeNames,
};
writeFileSync(join(here, 'fixtures.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log('ok');
