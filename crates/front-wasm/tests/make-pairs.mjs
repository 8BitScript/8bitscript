// Regenerates pairs/<n>.old.ast.json, the AST the JS parser makes of each
// old-syntax pair source. Run from the repo root:
//   node crates/front-wasm/tests/make-pairs.mjs
// Each `<n>.old.8bs` or `<n>.old.8bx` must lex and parse with no diagnostics. The dump is the
// canonical form (sorted keys, two-space indent, trailing newline). The new
// syntax side, `<n>.8bs`, is hand-written; `<n>.ast.json` beside it is the
// Rust parser's AST, written by `BLESS=1 cargo test -p front-wasm --test pairs`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../../../packages/compiler/src/lexer/index.mjs';
import { parse } from '../../../packages/compiler/src/parser/index.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'pairs');

const byCodeUnit = (a, b) => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};
const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort(byCodeUnit).map((k) => [k, sortKeys(v[k])]));
  }
  return v;
};
const canon = (v) => `${JSON.stringify(sortKeys(v), null, 2)}\n`;

let count = 0;
for (const name of readdirSync(dir).filter((f) => /\.old\.8b[sx]$/.test(f)).sort()) {
  const sourceKind = name.endsWith('.8bx') ? '.8bx' : '.8bs';
  const text = readFileSync(join(dir, name), 'utf8');
  const lexed = tokenize(text, name, { sourceKind });
  const parsed = parse(lexed.tokens, text, name, { sourceKind });
  const problems = [...lexed.diagnostics, ...parsed.diagnostics];
  if (problems.length > 0) {
    const detail = problems.map((d) => d.start + ': ' + d.message).join('; ');
    throw new Error(`${name}: ${detail}`);
  }
  writeFileSync(join(dir, name.replace(/\.8b[sx]$/, '.ast.json')), canon(parsed.ast));
  count += 1;
}
console.log(`${count} pairs`);
