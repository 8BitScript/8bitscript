// The editor host's entry. Marketplace VSIXes have no `src/`, so this
// just loads the published bundle. A linked source checkout rebuilds
// that bundle first when `src/` is newer, so Developer: Reload Window
// is enough to pick up edits you already saved.
const fs = require('fs');
const path = require('path');

const root = __dirname;
if (fs.existsSync(path.join(root, 'src', 'extension.cjs'))) {
  const { isBundleStale, rebuildSync } = require('./src/devReload.cjs');
  if (isBundleStale(root)) {
    process.stderr.write('8BitScript: src/ is newer than dist/; rebuilding the local extension.\n');
    rebuildSync(root);
  }
}

module.exports = require('./dist/extension.cjs');
