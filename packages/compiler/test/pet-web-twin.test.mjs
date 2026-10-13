// The PET's wasm build links one `.web` twin of its package files
// (input `.pet.web.8bs`) because the native file reads a chip — PIA 1's
// keyboard rows — that a wasm build has nothing behind. A twin is a copy with
// a few bodies replaced, and a copy drifts: a name added to input.8bs and not
// to its twin builds natively and fails only for the person running the
// browser build. This holds each twin to the names and signatures of the file
// it stands in for — every top-level export, and every member of every
// exported namespace — so the two cannot part company without this failing,
// and says which name is missing where. (The C64's and the VIC-20's twins
// are held the same way by c64-web-twin.test.mjs and vic20-web-twin.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tokenize, TokenKind } from '../src/lexer/index.mjs';
import { scanModule } from '../src/intellisense/index.mjs';

const SRC = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pet'), 'src');

/** Every top-level `export` of a module: name to its declaration up to the body or the end of the statement. */
function exportsOf(text) {
  const { tokens } = tokenize(text);
  const out = new Map();
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.text === '{') depth += 1;
    else if (token.text === '}') depth -= 1;
    if (depth !== 0 || token.kind !== TokenKind.Keyword || token.text !== 'export') continue;
    const kind = tokens[i + 1];
    if (!['let', 'const', 'function', 'namespace'].includes(kind.text)) continue;
    const name = tokens[i + 2].text;
    const parts = [kind.text];
    let j = i + 2;
    while (j < tokens.length && tokens[j].text !== '{' && tokens[j].text !== ';' && tokens[j].text !== '=') {
      parts.push(tokens[j].text);
      j += 1;
    }
    out.set(name, parts.join(' '));
  }
  return out;
}

const PAIRS = [
  ['input.8bs', 'input.pet.web.8bs'],
];

for (const [native, twin] of PAIRS) {
  test(`${twin} exports exactly what ${native} does: the same names, the same signatures`, () => {
    const a = readFileSync(join(SRC, native), 'utf8');
    const b = readFileSync(join(SRC, twin), 'utf8');
    const nativeExports = exportsOf(a);
    const twinExports = exportsOf(b);
    assert.ok(nativeExports.size > 0, `${native} has exports to compare`);
    assert.deepEqual([...twinExports.keys()].sort(), [...nativeExports.keys()].sort(), 'the same set of top-level exports');
    for (const [name, declaration] of nativeExports) {
      assert.equal(twinExports.get(name), declaration, `${name}: the declaration the same`);
    }
    // Every member of every exported namespace (input.poll, Input.CONFIRM_LABEL, ...): the same names and shapes.
    const exported = (all, exports) => new Map([...all].filter(([name]) => exports.get(name)?.startsWith('namespace')));
    const nativeSpaces = exported(scanModule(a), nativeExports);
    const twinSpaces = exported(scanModule(b), twinExports);
    assert.deepEqual([...twinSpaces.keys()].sort(), [...nativeSpaces.keys()].sort(), 'the same exported namespaces');
    for (const [space, members] of nativeSpaces) {
      assert.deepEqual([...twinSpaces.get(space).keys()].sort(), [...members.keys()].sort(), `${space}: the same members`);
      for (const [member, info] of members) {
        assert.equal(twinSpaces.get(space).get(member).signature, info.signature, `${space}.${member}: the same signature`);
      }
    }
  });
}

test('no web twin of the PET package reads the PIA or contains machine code: the wasm backend has neither', () => {
  for (const [, twin] of PAIRS) {
    const text = readFileSync(join(SRC, twin), 'utf8');
    const { tokens } = tokenize(text);
    assert.equal(tokens.filter((t) => t.text === 'asm6502').length, 0, `${twin} has an asm6502 block`);
    assert.equal(tokens.filter((t) => t.text === 'keyboard').length, 0, `${twin} reads the keyboard matrix, which is plain memory on this rail`);
  }
});
