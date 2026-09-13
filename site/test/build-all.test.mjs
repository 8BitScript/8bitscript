// Cloudflare Workers Builds clones without tags. The snapshot builder has
// to fetch them itself, or `/` publishes with no version history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { gitTags } from '../build-all.mjs';

const exec = promisify(execFile);

async function git(cwd, ...args) {
  await exec('git', args, { cwd });
}

async function initRepo(dir) {
  await git(dir, 'init', '-q');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'test');
}

test('a clone that already has v* tags does not need a remote', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-docs-tags-'));
  try {
    await initRepo(dir);
    await git(dir, 'commit', '--allow-empty', '-qm', 'docs');
    await git(dir, 'tag', 'v0.1.0');
    await git(dir, 'tag', 'v0.2.0');
    assert.deepEqual(await gitTags(dir), ['0.1.0', '0.2.0']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a tagless clone fetches v* tags from origin before giving up', async () => {
  const src = await mkdtemp(join(tmpdir(), '8bs-docs-src-'));
  const clone = await mkdtemp(join(tmpdir(), '8bs-docs-clone-'));
  try {
    await initRepo(src);
    await mkdir(join(src, 'docs'));
    await writeFile(join(src, 'docs', 'index.md'), '# hi\n');
    await git(src, 'add', 'docs');
    await git(src, 'commit', '-qm', 'docs');
    await git(src, 'tag', 'v0.1.0');
    await git(src, 'commit', '--allow-empty', '-qm', 'later');

    await rm(clone, { recursive: true, force: true });
    await exec('git', ['clone', '--depth', '1', '--no-tags', `file://${src}`, clone]);

    const { stdout } = await exec('git', ['tag', '-l', 'v*'], { cwd: clone });
    assert.equal(stdout.trim(), '', 'the clone has no tags yet');
    assert.deepEqual(await gitTags(clone), ['0.1.0']);
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(clone, { recursive: true, force: true });
  }
});

test('a repository with no v* tags and no remote still reports none', async () => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-docs-empty-'));
  try {
    await initRepo(dir);
    await git(dir, 'commit', '--allow-empty', '-qm', 'empty');
    assert.deepEqual(await gitTags(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
