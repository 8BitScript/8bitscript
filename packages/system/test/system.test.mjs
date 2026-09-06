// @8bitscript/system: one namespace naming every machine, with the number
// #system() folds to on it. The names must match the CLI's targets, the
// numbers must match the compiler's SYSTEMS table, and on every target a
// comparison against the right name must fold to a match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, link, SYSTEMS } from '../../compiler/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

// The names `8bs build --target` accepts, in the order the CLI lists them.
const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];

const index = readFileSync(join(SRC, 'index.8bs'), 'utf8');
const names = Object.fromEntries(
  [...index.matchAll(/const ([A-Z0-9]+): utinyint = (\d+);/g)].map(([, name, n]) => [name, Number(n)]),
);

test('System names every target once, with the number the compiler folds #system() to', () => {
  assert.deepEqual(Object.keys(names).sort(), TARGETS.map((t) => t.toUpperCase()).sort());
  assert.deepEqual([...SYSTEMS.keys()].sort(), TARGETS.slice().sort(), 'the compiler knows the same targets');
  for (const target of TARGETS) {
    assert.equal(names[target.toUpperCase()], SYSTEMS.get(target), `${target}: System.${target.toUpperCase()} is #system()'s number`);
  }
  assert.equal(new Set(Object.values(names)).size, TARGETS.length, 'the numbers are distinct');
});

test('the package is one file: no per-machine versions are needed any more', () => {
  assert.deepEqual(readdirSync(SRC), ['index.8bs']);
});

// Resolved as if it lived in Studio, the workspace's first consumer of this
// package: Studio's pnpm-linked node_modules is how an installed project
// would find @8bitscript/system too.
const PROBE = join(HERE, '..', '..', 'studio', 'src', 'system-probe.8bs');
const program = (name) => `import { System } from "@8bitscript/system";
let hit: utinyint = 0;
export function main(): void {
    if (#system() == System.${name}) {
        hit = 1;
    }
    while (true) {
        waitFrame();
    }
}
`;

test('on every target, #system() == System.<that target> is a comparison of two equal constants', () => {
  for (const target of TARGETS) {
    const { ir, diagnostics } = link(program(target.toUpperCase()), PROBE, { machine: target });
    assert.deepEqual(diagnostics, [], target);
    const test = ir.functions.find((f) => f.name === 'main').body.find((s) => s.kind === 'if').test;
    assert.deepEqual(test.left, { kind: 'const', value: SYSTEMS.get(target) }, `${target}: #system()`);
    assert.deepEqual(test.right, { kind: 'const', value: names[target.toUpperCase()] }, `${target}: System.${target.toUpperCase()}`);
  }
});

test('with no machine in hand, the program checks clean', () => {
  assert.deepEqual(analyze(program('C64'), PROBE, { resolveImports: true }), []);
});
