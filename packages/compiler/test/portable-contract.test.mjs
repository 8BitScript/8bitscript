// The portable packages keep one contract across their machines.
//
// `@8bitscript/screen`, `text`, `input`, `raster` and `pointer` are one
// file per machine behind one entry map. A program written for nine
// machines calls the same member on all of them, and the editor now shows
// that member as the API every machine agrees on (intellisense/index.mjs,
// mergeNamespace) — which is only honest if the machines *do* agree. This
// test reads every branch of every entry map in the workspace and fails
// when two machines give a member every machine has two different
// signatures. A disagreement that exists today is listed in KNOWN_DRIFT
// with why, so a new one fails and an old one is not forgotten: the list
// is a to-do for the packages, not an allowance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSpecifier } from '../src/resolver/index.mjs';
import { scanModule } from '../src/intellisense/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const packagesDir = join(root, 'packages');

/**
 * Signature drift the packages carry today. Each entry names the member,
 * the machines on each side, and why — remove it when the packages agree.
 */
const KNOWN_DRIFT = [
  {
    member: 'raster.at',
    why: 'the web host has up to 512 picture lines (Video.rows() * 8 on the resizable host), so `line` is usmallint there; the eight 6502 machines take utinyint. One contract wants usmallint everywhere, at a cost in every 6502 raster user — a decision for @8bitscript/raster, not for this test.',
  },
  {
    member: 'raster.insert',
    why: 'the same line as raster.at: usmallint on the web, utinyint on the eight 6502 machines — one decision covers both.',
  },
];

/** Every workspace package whose entry is a machine map, as `[name, { machine: specifier }]`. */
function portablePackages() {
  const out = [];
  for (const dir of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entry = manifest['8bitscript']?.entry;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) out.push([manifest.name, entry]);
  }
  return out;
}

/** `Map<'ns.member', [machine, signature][]>` across every machine of a package. */
function membersAcrossMachines(name, entry) {
  const from = join(packagesDir, 'compiler', 'test', 'portable-contract.test.mjs');
  const perMember = new Map();
  for (const machine of Object.keys(entry)) {
    const resolved = resolveSpecifier(name, from, { machine, checkout: root });
    assert.ok(resolved?.path, `${name} for ${machine}: ${resolved?.message ?? 'no file'}`);
    for (const [ns, members] of scanModule(readFileSync(resolved.path, 'utf8'))) {
      for (const [member, info] of members) {
        const key = `${ns}.${member}`;
        if (!perMember.has(key)) perMember.set(key, []);
        perMember.get(key).push([machine, info.signature]);
      }
    }
  }
  return perMember;
}

test('the workspace has portable packages to check', () => {
  const names = portablePackages().map(([name]) => name);
  assert.ok(names.includes('@8bitscript/screen') && names.includes('@8bitscript/text'), names.join(', '));
});

for (const [name, entry] of portablePackages()) {
  test(`${name}: a member every machine has means the same thing on every machine`, () => {
    const machines = Object.keys(entry);
    const drift = [];
    for (const [member, perMachine] of membersAcrossMachines(name, entry)) {
      if (perMachine.length < machines.length) continue; // machine-specific by design; the hover says where it exists
      const signatures = new Map();
      for (const [machine, signature] of perMachine) {
        if (!signatures.has(signature)) signatures.set(signature, []);
        signatures.get(signature).push(machine);
      }
      if (signatures.size === 1) continue;
      const known = KNOWN_DRIFT.find((k) => k.member === member);
      const shape = [...signatures].map(([sig, on]) => `${sig} on ${on.join(', ')}`).join(' | ');
      if (!known) drift.push(`${member}: ${shape}`);
    }
    assert.deepEqual(drift, [], `${name} has portable members whose signatures differ between machines — fix the packages, or record the drift in KNOWN_DRIFT with why:\n  ${drift.join('\n  ')}`);
  });
}

test('KNOWN_DRIFT names only drift that still exists', () => {
  const stale = [];
  for (const known of KNOWN_DRIFT) {
    const found = portablePackages().some(([name, entry]) => {
      const perMachine = membersAcrossMachines(name, entry).get(known.member);
      return perMachine && new Set(perMachine.map(([, s]) => s)).size > 1;
    });
    if (!found) stale.push(known.member);
  }
  assert.deepEqual(stale, [], `no longer drifting — remove from KNOWN_DRIFT: ${stale.join(', ')}`);
});
