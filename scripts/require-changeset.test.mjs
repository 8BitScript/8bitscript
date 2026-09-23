import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  changesetRequired,
  isChangesetFile,
  isPublishedPath,
  isVersionReleasePullRequest,
} from './require-changeset.mjs';

test('a package or editor change with no changeset is rejected', () => {
  assert.equal(
    changesetRequired({
      files: ['packages/cli/src/font8x8.mjs'],
      headRef: 'feat/web-corner-glyphs',
    }).required,
    true,
  );
  assert.equal(
    changesetRequired({
      files: ['editors/vscode/src/extension.cjs'],
      headRef: 'feat/editor',
    }).required,
    true,
  );
});

test('a changeset committed with the package change is accepted', () => {
  const result = changesetRequired({
    files: ['packages/web/src/text.8bs', '.changeset/web-corner-glyphs.md'],
    headRef: 'feat/web-corner-glyphs',
  });
  assert.equal(result.required, false);
  assert.deepEqual(result.published, ['packages/web/src/text.8bs']);
});

test('docs, the site, and CI do not need a changeset', () => {
  const result = changesetRequired({
    files: [
      'README.md',
      'docs/index.md',
      'docs/assets/css/main.css',
      'site/layout.mjs',
      '.github/workflows/docs.yml',
      'CONTRIBUTING.md',
    ],
    headRef: 'docs/development-status',
  });
  assert.equal(result.required, false);
  assert.deepEqual(result.published, []);
});

test('the Version Packages pull request is exempt', () => {
  assert.equal(isVersionReleasePullRequest('changeset-release/trunk'), true);
  const result = changesetRequired({
    files: ['packages/cli/package.json', 'packages/cli/CHANGELOG.md', 'package.json'],
    headRef: 'changeset-release/trunk',
  });
  assert.equal(result.required, false);
});

test('the changeset folder readme does not count as a changeset', () => {
  assert.equal(isChangesetFile('.changeset/README.md'), false);
  assert.equal(isChangesetFile('.changeset/web-corner-glyphs.md'), true);
  assert.equal(isPublishedPath('packages/cli/src/font8x8.mjs'), true);
  assert.equal(isPublishedPath('docs/index.md'), false);
  const result = changesetRequired({
    files: ['packages/cli/src/font8x8.mjs', '.changeset/README.md'],
    headRef: 'feat/web-corner-glyphs',
  });
  assert.equal(result.required, true);
});
