const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  editorsToLink, extensionDirName, extensionsRoot, linkLocal, unlinkLocal,
} = require('../src/linkLocal.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), '8bs-link-'));
}

function writePkg(dir, version = '0.7.1') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '8bitscript-lang',
    publisher: '8bitscript',
    version,
  }));
}

test('with no flags, Cursor wins when both editors are installed', () => {
  const exists = (p) => p.includes('.cursor') || p.includes('.vscode');
  assert.deepEqual(editorsToLink([], '/home/me', exists), ['cursor']);
  assert.deepEqual(editorsToLink(['--vscode'], '/home/me', exists), ['vscode']);
  assert.deepEqual(editorsToLink(['--cursor', '--also-vscode'], '/home/me', exists), ['cursor', 'vscode']);
  assert.deepEqual(
    editorsToLink([], '/home/me', (p) => p.includes('.vscode')),
    ['vscode'],
  );
});

test('the install folder is publisher.name-version under the editor’s extensions dir', () => {
  const pkg = { publisher: '8bitscript', name: '8bitscript-lang', version: '0.7.1' };
  assert.equal(extensionDirName(pkg), '8bitscript.8bitscript-lang-0.7.1');
  assert.equal(
    extensionsRoot('/home/me', 'cursor'),
    path.join('/home/me', '.cursor', 'extensions'),
  );
  assert.equal(
    extensionsRoot('/home/me', 'vscode'),
    path.join('/home/me', '.vscode', 'extensions'),
  );
});

test('link-local replaces a VSIX copy with a symlink named for this version', () => {
  const home = tmpDir();
  const src = tmpDir();
  try {
    writePkg(src, '0.7.1');
    const vsix = path.join(home, '.cursor', 'extensions', '8bitscript.8bitscript-lang-0.2.5');
    fs.mkdirSync(vsix, { recursive: true });
    fs.writeFileSync(path.join(vsix, 'package.json'), '{"version":"0.2.5"}');
    fs.writeFileSync(
      path.join(home, '.cursor', 'extensions', 'unrelated.ext-1.0.0'),
      'leave me',
    );

    const dest = linkLocal({ home, editor: 'cursor', extensionRoot: src });
    assert.equal(dest, path.join(home, '.cursor', 'extensions', '8bitscript.8bitscript-lang-0.7.1'));
    assert.equal(fs.lstatSync(dest).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(dest), path.resolve(src));
    assert.equal(fs.existsSync(vsix), false, 'the pinned VSIX copy is gone');
    assert.equal(
      fs.readFileSync(path.join(home, '.cursor', 'extensions', 'unrelated.ext-1.0.0'), 'utf8'),
      'leave me',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('a second link-local call replaces the previous symlink without touching the source', () => {
  const home = tmpDir();
  const src = tmpDir();
  try {
    writePkg(src, '0.7.1');
    fs.writeFileSync(path.join(src, 'keep.txt'), 'source');
    linkLocal({ home, editor: 'cursor', extensionRoot: src });
    const dest = linkLocal({ home, editor: 'cursor', extensionRoot: src });
    assert.equal(fs.lstatSync(dest).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(src, 'keep.txt'), 'utf8'), 'source');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('unlinkLocal removes the dev symlink and leaves everything else alone', () => {
  const home = tmpDir();
  const src = tmpDir();
  try {
    writePkg(src, '0.7.1');
    const dest = linkLocal({ home, editor: 'cursor', extensionRoot: src });
    fs.writeFileSync(
      path.join(home, '.cursor', 'extensions', 'unrelated.ext-1.0.0'),
      'leave me',
    );
    unlinkLocal({ home, editor: 'cursor', publisher: '8bitscript', name: '8bitscript-lang' });
    assert.equal(fs.existsSync(dest), false);
    assert.equal(
      fs.readFileSync(path.join(home, '.cursor', 'extensions', 'unrelated.ext-1.0.0'), 'utf8'),
      'leave me',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});

test('unlinkLocal on an extensions folder that does not exist yet is a no-op', () => {
  const home = tmpDir();
  try {
    unlinkLocal({ home, editor: 'vscode', publisher: '8bitscript', name: '8bitscript-lang' });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
