// @8bitscript/system: one namespace naming every machine, and CURRENT the
// one being built for. The names must match the CLI's targets, the numbers
// in the per-machine `current.<target>.8bs` files must match the names,
// and on every target the constant must fold to that machine's number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, link } from '../../compiler/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

// The names `8bs build --target` accepts, in the order the CLI lists them.
const TARGETS = ['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web'];

const index = readFileSync(join(SRC, 'index.8bs'), 'utf8');
const names = Object.fromEntries(
  [...index.matchAll(/const ([A-Z0-9]+): utinyint = (\d+);/g)].map(([, name, n]) => [name, Number(n)]),
);

test('System names every target once, and nothing else', () => {
  assert.deepEqual(Object.keys(names).sort(), TARGETS.map((t) => t.toUpperCase()).sort());
  assert.equal(new Set(Object.values(names)).size, TARGETS.length, 'the numbers are distinct');
});

test('every target has its current.<target>.8bs, and no other file does', () => {
  const variants = readdirSync(SRC).filter((f) => f.startsWith('current.')).sort();
  assert.deepEqual(variants, TARGETS.map((t) => `current.${t}.8bs`).sort());
  for (const target of TARGETS) {
    const text = readFileSync(join(SRC, `current.${target}.8bs`), 'utf8');
    const n = Number(/const SYSTEM: utinyint = (\d+);/.exec(text)[1]);
    assert.equal(n, names[target.toUpperCase()], `${target}: current.8bs's number is System.${target.toUpperCase()}'s`);
  }
});

// Link a program on each target and read what System.CURRENT folded to.
// The program is resolved as if it lived in Studio, the workspace's first
// consumer of this package: Studio's pnpm-linked node_modules is how an
// installed project would find @8bitscript/system too.
const PROBE = join(HERE, '..', '..', 'studio', 'src', 'system-probe.8bs');
const PROGRAM = `import { System } from "@8bitscript/system";
let id: utinyint = 0;
export function main(): void {
    id = System.CURRENT;
    while (true) {
        waitFrame();
    }
}
`;

test('System.CURRENT is each machine\'s own number, folded at compile time', () => {
  for (const target of TARGETS) {
    const { ir, diagnostics } = link(PROGRAM, PROBE, { machine: target });
    assert.deepEqual(diagnostics, [], target);
    const assign = ir.functions.find((f) => f.name === 'main').body.find((s) => s.kind === 'assign' && s.target === 'id');
    assert.deepEqual(assign.value, { kind: 'const', value: names[target.toUpperCase()] }, target);
  }
});

// `8bs check` and the editor analyse a file with no machine in hand: the
// import resolves, and the per-machine `current.8bs` behind it is accepted
// as valid-but-target-dependent (docs/packages.md, "System-specific
// files"). Only a build needs a machine.
test('with no machine in hand, the import checks clean', () => {
  assert.deepEqual(analyze(PROGRAM, PROBE, { resolveImports: true }), []);
});
