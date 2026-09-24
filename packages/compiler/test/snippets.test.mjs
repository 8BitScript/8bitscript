// The VS Code extension's snippets, checked against the compiler.
//
// A snippet that expands to something the compiler rejects is worse than no
// snippet — it teaches syntax the language does not have. The extension
// cannot import the compiler (it ships to an editor, not to Node), and the
// compiler is the source of truth for what compiles, so the check lives
// here: expand each snippet the way accepting it would, and analyse the
// result.
//
// This is also what keeps the snippets honest as the compiled subset grows
// or shrinks: a construct leaving the subset fails here, in the compiler's
// own suite, rather than silently misleading someone in an editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNIPPETS_ROOT = join(HERE, '..', '..', '..', 'editors', 'vscode', 'snippets');

const SNIPPET_SETS = [
  {
    file: '8bs.json',
    fileName: 't.8bs',
    wrap: wrap8bs,
    ignoreCodes: ['8BS2007'],
  },
  {
    file: '8bg.json',
    fileName: 't.8bg',
    wrap: wrap8bg,
    ignoreCodes: [],
  },
  {
    file: '8ba.json',
    fileName: 't.8ba',
    wrap: wrap8ba,
    ignoreCodes: [],
  },
];

function loadSnippets(file) {
  return Object.entries(JSON.parse(readFileSync(join(SNIPPETS_ROOT, file), 'utf8')))
    .filter(([name]) => !name.startsWith('_'));
}

/**
 * What lands in the buffer when someone accepts a snippet and tabs through
 * it: every placeholder replaced by its default (or by nothing), and every
 * escaped `\\$` — a template string's own `${...}`, which is text, not a
 * placeholder — restored. The escaped ones are parked on a character that
 * cannot appear in source while the placeholders are stripped, so a `$` a
 * snippet means literally is never mistaken for one it doesn't.
 */
const ESCAPED_DOLLAR = '\u0000';

function expand(body) {
  return body.join('\n')
    .replace(/\\\$/g, ESCAPED_DOLLAR)
    .replace(/\$\{\d+\|([^}|]+)[^}]*\}/g, '$1')
    .replace(/\$\{\d+:([^{}|]*)\}/g, '$1')
    .replace(/\$\{\d+\}/g, '')
    .replace(/\$\d+/g, '')
    .replaceAll(ESCAPED_DOLLAR, '$');
}

/**
 * The smallest program that gives a fragment somewhere to live: a
 * declaration at the top level, a statement inside a function, an
 * expression inside a declaration. The globals a snippet's placeholders
 * name are declared so the fragment is complete on its own.
 */
function wrap8bs(text) {
  const trimmed = text.trim();
  if (/^(export |import |let |const |function |namespace |@address)/.test(trimmed)) {
    return `${trimmed}\nexport function __entry(): void { }`;
  }
  // An expression is assigned to a global rather than declared into one: a
  // global's initializer must be a compile-time value, and a snippet like
  // `memory.read(...)` is deliberately a runtime one.
  const statement = /[;{]/.test(trimmed) ? trimmed : `__value = ${trimmed};`;
  return [
    'import { text } from "@8bitscript/text";',
    'let ticks: utinyint = 0;',
    'let framesUntilTick: utinyint = 0;',
    'let __value: usmallint = 0;',
    'export function __entry(): void {',
    statement,
    '}',
  ].join('\n');
}

function wrap8bg(text) {
  const trimmed = text.trim();
  if (/^animation\b/.test(trimmed)) {
    return [
      'sprite __snippet {',
      '  source "./a.png"',
      '  size 8x8',
      ...trimmed.split('\n').map((line) => `\t${line}`),
      '}',
    ].join('\n');
  }
  return `${trimmed}\n`;
}

function wrap8ba(text) {
  let trimmed = text.trim();
  if (/^song\b/.test(trimmed)) {
    const track = trimmed.match(/\btrack\s+(\w+)/)?.[1];
    if (track && !new RegExp(`^instrument\\s+${track}\\b`, 'm').test(trimmed)) {
      trimmed = `instrument ${track} {\n\twaveform pulse\n\tpolyphony 1\n}\n\n${trimmed}`;
    }
  }
  return `${trimmed}\n`;
}

for (const { file, fileName, wrap, ignoreCodes } of SNIPPET_SETS) {
  const snippets = loadSnippets(file);
  const ignore = new Set(ignoreCodes);

  test(`every ${file} snippet has a body that expands to something`, () => {
    assert.ok(snippets.length > 0, `no snippets found in ${file}`);
    for (const [name, snippet] of snippets) {
      assert.ok(expand(snippet.body).trim().length > 0, `${name} expands to nothing`);
    }
  });

  test(`every ${file} snippet expands to something the compiler accepts`, () => {
    for (const [name, snippet] of snippets) {
      const source = wrap(expand(snippet.body));
      const diagnostics = analyze(source, fileName)
        .filter((d) => !ignore.has(d.code))
        .map((d) => `${d.code} ${d.message}`);
      assert.deepEqual(diagnostics, [], `${name}\n${source}`);
    }
  });
}

const bsSnippets = loadSnippets('8bs.json');

test('the snippets stay inside the compiled subset — nothing offers a construct that does not lower', () => {
  const bodies = bsSnippets.map(([, s]) => s.body.join('\n')).join('\n');
  for (const [construct, pattern] of [
    ['a pointer', /\bptr</],
  ]) {
    assert.doesNotMatch(bodies, pattern, `a snippet offers ${construct}, which does not compile yet`);
  }
});
