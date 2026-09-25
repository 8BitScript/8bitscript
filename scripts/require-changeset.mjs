// A pull request that changes a published package must carry a changeset,
// or the version bot never opens a release and the change ships nowhere.
// Docs, the site, and CI do not. The Version Packages pull request
// (changeset-release/*) consumes changesets, so it is exempt.
//
// `pnpm changeset --empty` is the explicit opt-out for a package change
// that must not be released. Silence is not an opt-out.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PUBLISHED_PREFIXES = ['packages/', 'editors/'];

export function isVersionReleasePullRequest(headRef) {
  return String(headRef ?? '').startsWith('changeset-release/');
}

/** A real changeset. The folder's own README is not one. */
export function isChangesetFile(file) {
  return file.startsWith('.changeset/') && file.endsWith('.md') && file !== '.changeset/README.md';
}

export function isPublishedPath(file) {
  return PUBLISHED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/** Version Packages bot aligns every packages/* version; not a semver bump. */
export function isLockstepPackageJsonOnly(files) {
  const published = files.filter(isPublishedPath);
  if (published.length === 0) return false;
  if (!files.includes('scripts/sync-lockstep-versions.mjs')) return false;
  return published.every((file) => /^packages\/[^/]+\/package\.json$/.test(file));
}

/**
 * @param {{ files: string[], headRef?: string }} input
 * @returns {{ required: boolean, published: string[] }}
 */
export function changesetRequired({ files, headRef }) {
  const published = files.filter(isPublishedPath);
  if (isVersionReleasePullRequest(headRef) || published.length === 0) {
    return { required: false, published };
  }
  if (isLockstepPackageJsonOnly(files)) return { required: false, published };
  if (files.some(isChangesetFile)) return { required: false, published };
  return { required: true, published };
}

function filesFromStdin() {
  return readFileSync(0, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

function main() {
  const headRef = process.env.HEAD_REF || '';
  if (process.stdin.isTTY) {
    console.error('Pipe `git diff --name-only <base>...<head>` on stdin.');
    process.exit(2);
  }

  const result = changesetRequired({ files: filesFromStdin(), headRef });
  if (!result.required) {
    console.log('Changeset check passed.');
    return;
  }

  console.error('This pull request changes a published package and has no changeset:');
  for (const file of result.published) console.error(`  ${file}`);
  console.error('');
  console.error('Add one with `pnpm changeset` and commit the file under .changeset/.');
  console.error('If this change must not be released, `pnpm changeset --empty` records that choice.');
  console.error('Docs, the site, and CI do not need one. The Version Packages pull request is exempt.');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
