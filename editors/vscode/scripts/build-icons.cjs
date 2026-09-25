'use strict';

// The explorer fetches a file icon by URL and caches it under that URL, so
// editing an SVG in place leaves the old drawing on screen no matter how many
// times the window reloads. Each icon is therefore copied out of icons/src
// under a content-hashed name: new art is a new URL, and the editor re-fetches.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const THEME = path.join('themes', '8bitscript-icon-theme.json');

// Drawn twice, because a violet that reads on a dark background is washed out
// on a light one. The three supporting kinds are here rather than below so a
// `.wav` can carry the same amber as the `.8ba` badge in either theme.
const THEMED = ['8bs', '8bx', '8bg', '8ba', 'image', 'audio', 'code'];
const PILLARS = ['8bs', '8bx', '8bg', '8ba'];

// Everything else a project holds. A file icon theme replaces *every* icon in
// the explorer, so without these a `.png` beside a `.8bg` would have none.
const SHARED = ['file', 'folder', 'folder-open', 'data', 'doc', 'binary', 'git', 'license'];

const BY_EXTENSION = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', ico: 'image',
  wav: 'audio', mp3: 'audio', ogg: 'audio', flac: 'audio', mid: 'audio', midi: 'audio', sid: 'audio', mod: 'audio',
  ts: 'code', tsx: 'code', js: 'code', mjs: 'code', cjs: 'code', jsx: 'code', html: 'code', css: 'code', sh: 'code', py: 'code', asm: 'code', s: 'code',
  json: 'data', jsonc: 'data', yml: 'data', yaml: 'data', toml: 'data', xml: 'data', csv: 'data',
  md: 'doc', txt: 'doc', log: 'doc', pdf: 'doc',
  prg: 'binary', d64: 'binary', d81: 'binary', t64: 'binary', tap: 'binary', crt: 'binary', bin: 'binary',
  rom: 'binary', nes: 'binary', sna: 'binary', vsix: 'binary', zip: 'binary', wasm: 'binary', map: 'binary',
};

// A project's own config wears the language's own 8.
const BY_FILENAME = {
  '8bitscript.config.ts': '8bs',
  '8bs.config.ts': '8bs',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  LICENSE: 'license',
  'LICENSE.md': 'license',
  'LICENSE.txt': 'license',
};

/** What the generated icons and theme should be, without touching the disk. */
function plan(root) {
  const files = [];
  const iconDefinitions = {};
  const seen = new Map();

  // `id` is the theme's name for one drawing; a pillar has a dark and a light
  // one, everything else is drawn once and used by both.
  const define = (id, name) => {
    if (seen.has(id)) return id;
    const contents = fs.readFileSync(path.join(root, 'icons', 'src', `${name}.svg`));
    const digest = crypto.createHash('sha256').update(contents).digest('hex').slice(0, 8);
    const file = `${name}.${digest}.svg`;
    files.push({ file, contents });
    iconDefinitions[id] = { iconPath: `../icons/file/${file}` };
    seen.set(id, file);
    return id;
  };

  for (const name of SHARED) define(`_${name}`, name);
  for (const name of THEMED) {
    define(`_${name}_dark`, `${name}-dark`);
    define(`_${name}_light`, `${name}-light`);
  }

  // An icon drawn twice is named per theme; one drawn once is named on its
  // own, and the `light` section simply has nothing to say about it.
  const assign = (into, lightInto, key, icon) => {
    if (THEMED.includes(icon)) {
      into[key] = `_${icon}_dark`;
      lightInto[key] = `_${icon}_light`;
    } else {
      into[key] = `_${icon}`;
    }
  };

  const fileExtensions = {};
  const lightExtensions = {};
  for (const pillar of PILLARS) assign(fileExtensions, lightExtensions, pillar, pillar);
  for (const [extension, icon] of Object.entries(BY_EXTENSION)) {
    assign(fileExtensions, lightExtensions, extension, icon);
  }

  const fileNames = {};
  const lightNames = {};
  for (const [name, icon] of Object.entries(BY_FILENAME)) assign(fileNames, lightNames, name, icon);

  // A file icon theme has no per-definition light variant: the `light` section
  // points the same extension at a different definition instead, and anything
  // it leaves out falls back to the definition above.
  const theme = {
    file: '_file',
    folder: '_folder',
    folderExpanded: '_folder-open',
    rootFolder: '_folder',
    rootFolderExpanded: '_folder-open',
    iconDefinitions,
    fileExtensions,
    fileNames,
    light: { fileExtensions: lightExtensions, fileNames: lightNames },
    highContrast: { fileExtensions: { ...fileExtensions }, fileNames: { ...fileNames } },
  };
  return { files, theme, themeText: `${JSON.stringify(theme, null, 2)}\n` };
}

function build(root) {
  const planned = plan(root);
  const outDir = path.join(root, 'icons', 'file');
  fs.mkdirSync(outDir, { recursive: true });
  const keep = new Set(planned.files.map((icon) => icon.file));
  for (const existing of fs.readdirSync(outDir)) {
    if (!keep.has(existing)) fs.rmSync(path.join(outDir, existing));
  }
  for (const icon of planned.files) {
    fs.writeFileSync(path.join(outDir, icon.file), icon.contents);
  }
  fs.writeFileSync(path.join(root, THEME), planned.themeText);
  return planned;
}

module.exports = { build, plan, PILLARS, THEMED, SHARED, BY_EXTENSION, BY_FILENAME, THEME };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const { files } = build(path.join(__dirname, '..'));
  console.log(`icons: ${files.length} written`);
}
