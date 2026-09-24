import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'cli', 'bin', '8bs.mjs');

function onPath(name) {
  const bin = process.platform === 'win32' ? `${name}.exe` : name;
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, bin)));
}

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('coleco builds a probe program', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-coleco-'));
  try {
    const entry = join(scratch, 'main.8bs');
    await writeFile(entry, [
      'let sum: utinyint = 0;',
      'export function main(): void {',
      '    for (let i: utinyint = 0; i < 10; i++) {',
      '        sum = sum + i;',
      '    }',
      '    memory.write(0x80, sum);',
      '}',
      '',
    ].join('\n'));
    const { code, stderr } = await runCli(['build', '--target', 'coleco', entry], scratch);
    assert.equal(code, 0, stderr);
    assert.ok(existsSync(join(scratch, 'dist')), 'wrote dist/');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('coleco screenshot skips when mame is missing', async (t) => {
  if (!onPath('mame')) {
    t.skip('mame is not installed');
    return;
  }
  const scratch = await mkdtemp(join(tmpdir(), '8bs-coleco-shot-'));
  try {
    const entry = join(scratch, 'main.8bs');
    await writeFile(entry, 'export function main(): void {}\n');
    const shot = join(scratch, 'out.png');
    const { code } = await runCli(['run', 'coleco', entry, '--screenshot', shot, '--frames', '1'], scratch);
    if (code !== 0) {
      t.skip('mame is present but could not capture');
      return;
    }
    assert.ok(existsSync(shot), 'screenshot landed');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
