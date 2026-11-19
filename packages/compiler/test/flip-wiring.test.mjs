// F-01b: the compiler runs on the new front end. A `use` path links through
// the extension search, the diagnostics and the catalog speak the new words,
// and intellisense reads `use` paths.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { getCompletions, getDefinition, getHoverInfo, link, prepareCatalog } from '../index.mjs';
import * as direct from '../src/checker/scopes.mjs';
import * as scopes from '@8bitscript/compiler/scopes';

const withFiles = (files, fn) => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-wiring-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const GEO = 'pub const A: utinyint = 3;\n';
const MAIN = 'use self::geo::{A};\npub fn main() { memory::write(0x80, A); }\n';

test('link: use self::geo::{a} resolves geo.8bx, and two matching extensions are 8BS2217', () => {
  withFiles({ 'geo.8bx': GEO, 'main.8bs': MAIN }, (dir) => {
    const result = link(MAIN, join(dir, 'main.8bs'));
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.ir);
  });
  withFiles({ 'geo.8bx': GEO, 'geo.8bs': GEO, 'main.8bs': MAIN }, (dir) => {
    const ambiguous = link(MAIN, join(dir, 'main.8bs')).diagnostics.filter((d) => d.code === '8BS2217');
    assert.equal(ambiguous.length, 1);
    assert.match(ambiguous[0].message, /geo/);
  });
});

test('link: a use path that matches no file is 8BS2004', () => {
  withFiles({ 'main.8bs': MAIN }, (dir) => {
    const missing = link(MAIN, join(dir, 'main.8bs')).diagnostics.filter((d) => d.code === '8BS2004');
    assert.equal(missing.length, 1);
    assert.match(missing[0].message, /geo/);
  });
});

test('link: messages use the new words', () => {
  const src = 'pub mod m { pub fn f() {} }\npub fn main() {}\n';
  withFiles({ 'main.8bs': src }, (dir) => {
    const messages = link(src, join(dir, 'main.8bs')).diagnostics.map((d) => d.message);
    assert.deepEqual(messages, ["the entry module may pub only its entry fn; 'm' is a mod"]);
    assert.doesNotMatch(messages.join('\n'), /\bnamespace\b|\bfunction\b|\bexport\b/);
  });
});

test('the merged catalog is written as pub mod with plain consts', () => {
  withFiles({
    'src/i18n/en.8bs': 'pub mod Game {\n    const NAME: string = "2048";\n}\n',
    'src/i18n/de.8bs': 'pub mod Game {\n    const NAME: string = "SPIEL";\n}\n',
  }, (dir) => {
    const prepared = prepareCatalog({
      locale: 'de',
      i18n: { catalogDir: join(dir, 'src', 'i18n'), defaultLocale: 'en', fallbackLocale: 'en', locales: ['en', 'de'], charset: 'transliterate' },
    });
    assert.equal(prepared.ok, true, prepared.diagnostics.map((d) => d.message).join('\n'));
    assert.match(prepared.text, /pub mod Game \{/);
    assert.match(prepared.text, /const NAME: string = "SPIEL";/);
    assert.doesNotMatch(prepared.text, /export namespace|\bfunction\b/);
  });
});

test('the scope helpers are a subpath export, not a root export', async () => {
  assert.equal(scopes.walkScopes, direct.walkScopes);
  assert.equal(typeof scopes.scopeLookup, 'function');
  const root = await import('../index.mjs');
  assert.equal(root.walkScopes, undefined);
});

test('completion and definition read a use path', () => {
  withFiles({ 'geo.8bs': 'pub mod geo {\n    pub fn spin() {}\n}\n', 'main.8bs': 'use self::geo::geo;\npub fn main() { geo::spin(); }\n' }, (dir) => {
    const path = join(dir, 'main.8bs');
    const text = 'use self::geo::geo;\npub fn main() { geo::spin(); }\n';
    const def = getDefinition(text, text.lastIndexOf('spin') + 1, { path });
    assert.equal(def?.path, join(dir, 'geo.8bs'));
    const items = getCompletions(text, text.lastIndexOf('::') + 2, { path });
    assert.ok(items.some((item) => item.label === 'spin'), JSON.stringify(items));
    assert.ok(getHoverInfo(text, text.lastIndexOf('spin') + 1, { path }));
  });
});

test('definition and completion read a braced use list and a return type position', () => {
  const geo = 'pub mod geo {\n    pub fn spin() {}\n    pub fn turn() {}\n}\npub mod other {\n    pub fn go() {}\n}\n';
  const text = 'use self::geo::{geo, other};\npub fn main() { other::go(); }\n';
  withFiles({ 'geo.8bs': geo, 'main.8bs': text }, (dir) => {
    const path = join(dir, 'main.8bs');
    const def = getDefinition(text, text.lastIndexOf('go') + 1, { path });
    assert.equal(def?.path, join(dir, 'geo.8bs'));
    const items = getCompletions(text, text.lastIndexOf('::') + 2, { path });
    assert.ok(items.some((item) => item.label === 'go'), JSON.stringify(items));
  });
  const ret = 'pub fn f() -> ';
  assert.ok(getCompletions(ret, ret.length).some((item) => item.label === 'u8'));
});
