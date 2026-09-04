import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMissingPackages, missingPacmanPackages, installPacmanPackages, XEMU_BUILD_PACKAGES,
  missingBrewPackages, installBrewPackages, missingPathTools, CX16_BREW_PACKAGES,
} from '../src/setup/deps.mjs';

test('parseMissingPackages: one package per line, blank output means nothing missing', () => {
  assert.deepEqual(parseMissingPackages('sdl2-compat\ngtk3\n'), ['sdl2-compat', 'gtk3']);
  assert.deepEqual(parseMissingPackages(''), []);
  assert.deepEqual(parseMissingPackages('\n\n'), []);
});

test('missingPacmanPackages: everything already installed (pacman -T prints nothing)', async () => {
  const missing = await missingPacmanPackages(XEMU_BUILD_PACKAGES, async (cmd, args) => {
    assert.equal(cmd, 'pacman');
    assert.deepEqual(args, ['-T', ...XEMU_BUILD_PACKAGES]);
    return { code: 0, stdout: '', stderr: '', missing: false };
  });
  assert.deepEqual(missing, []);
});

test('missingPacmanPackages: reports the subset pacman -T names as unsatisfied', async () => {
  const missing = await missingPacmanPackages(['git', 'gtk3', 'readline'], async () => (
    { code: 127, stdout: 'gtk3\nreadline\n', stderr: '', missing: false }
  ));
  assert.deepEqual(missing, ['gtk3', 'readline']);
});

test('missingPacmanPackages: pacman itself not found -> treat everything as missing rather than crash', async () => {
  const missing = await missingPacmanPackages(['git'], async () => ({ missing: true }));
  assert.deepEqual(missing, ['git']);
});

test('installPacmanPackages: runs `pacman -S --needed <packages>` under sudo, no --noconfirm (pacman prompts itself)', async () => {
  let calledWith = null;
  await installPacmanPackages(['gtk3', 'readline'], async (cmd, args) => {
    calledWith = [cmd, args];
    return { code: 0 };
  });
  assert.deepEqual(calledWith, ['pacman', ['-S', '--needed', 'gtk3', 'readline']]);
});

// ---- Homebrew --------------------------------------------------------------

test('missingBrewPackages: one `brew list --versions <all>` call, exit 0 means nothing missing', async () => {
  const calls = [];
  const missing = await missingBrewPackages(CX16_BREW_PACKAGES, async (cmd, args) => {
    calls.push([cmd, args]);
    return { code: 0, stdout: 'cc65 2.19\ncmake 4.4.3\ngit 2.55.0\nlzsa 1.4.1\npkgconf 2.5\npython@3.14 3.14.7\nsdl2-compat 2.32.72\n', stderr: '', missing: false };
  });
  assert.deepEqual(missing, []);
  assert.deepEqual(calls, [['brew', ['list', '--versions', ...CX16_BREW_PACKAGES]]]);
});

test('missingBrewPackages: on a non-zero combined exit, asks per package — aliases (python -> python@3.14, sdl2 -> sdl2-compat) never count as missing', async () => {
  const installed = new Set(['git', 'cmake', 'python', 'sdl2', 'cc65']);
  const calls = [];
  const missing = await missingBrewPackages(CX16_BREW_PACKAGES, async (cmd, args) => {
    calls.push(args);
    const asked = args.slice(2);
    if (asked.length > 1) return { code: 1, stdout: 'cc65 2.19\ncmake 4.4.3\ngit 2.55.0\npython@3.14 3.14.7\nsdl2-compat 2.32.72\n', stderr: '', missing: false };
    return { code: installed.has(asked[0]) ? 0 : 1, stdout: '', stderr: '', missing: false };
  });
  assert.deepEqual(missing, ['pkgconf', 'lzsa']);
  assert.equal(calls.length, 1 + CX16_BREW_PACKAGES.length);
});

test('missingBrewPackages: brew itself not found -> everything is missing rather than a crash', async () => {
  assert.deepEqual(await missingBrewPackages(['git', 'cmake'], async () => ({ missing: true })), ['git', 'cmake']);
});

test('installBrewPackages: `brew install <packages>` as the user — the exec passed is the plain one, never sudo', async () => {
  let seen = null;
  await installBrewPackages(['pkgconf', 'lzsa'], async (cmd, args) => { seen = [cmd, args]; return { code: 0 }; });
  assert.deepEqual(seen, ['brew', ['install', 'pkgconf', 'lzsa']]);
});

test('missingPathTools: AUR-only tools are checked as binaries on PATH', () => {
  assert.deepEqual(missingPathTools(['cc65', 'lzsa'], (b) => b === 'cc65'), ['lzsa']);
  assert.deepEqual(missingPathTools(['cc65', 'lzsa'], () => true), []);
});
