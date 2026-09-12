// Where a project's controller profiles live, and how they are read back.
//
// `fs` and `path` only — no `vscode` — so the whole of "where is the file,
// what is in it, what goes back into it" is tested with plain `node --test`
// against a temporary directory, and controllerView.cjs is left with
// nothing but the editor glue. Same split as hardwareCatalog.cjs and
// runner.cjs next door.
//
// ---- why a file of its own, beside 8bitscript.config.ts ------------------
//
// The obvious alternative is a `controllers` block inside
// `8bitscript.config.ts`, next to `targets`, `systems` and `requires`.
// It is the wrong home, for three reasons, and the third is the decisive
// one:
//
// 1. **The config is source.** runner.cjs's `saveSystem` writes into it and
//    goes out of its way to do so through a `WorkspaceEdit` — so the write
//    lands in the undo stack, an open buffer stays in step, and a config
//    whose shape it cannot safely edit is *opened with the entry to paste*
//    rather than guessed at (projects.cjs's `insertSystem` refuses a file
//    it does not recognize). That care is right for a line a person will
//    read. A controller profile is eighteen machine-generated bindings per
//    device, rewritten every time a button is pressed in a walkthrough;
//    putting that through a TypeScript source rewriter would mean either a
//    far more capable rewriter or a panel that frequently cannot save.
//
// 2. **It is not knowledge the compiler needs.** `targets`, `systems` and
//    `requires` change what is built. Which physical pad is Player 1 does
//    not: it is something an emulator is launched with. A build input and
//    a launch input in the same file would have to be told apart by
//    everything that reads it.
//
// 3. **JSON is what the other end can read.** The CLI reads the config by
//    evaluating TypeScript (`packages/cli/src/config.mjs`). Anything else
//    that ever wants these profiles — an emulator adapter, a second
//    editor, a CI job checking a mapping still resolves — would have to do
//    the same. A JSON file beside it is `JSON.parse` for all of them, and
//    it is the same choice `8bs` already makes for the run reports it
//    leaves in `dist/.8bs-last-<target>.json`.
//
// The cost is a second file in the project root, and it is checked in on
// purpose: a mapping is the team's, the way a `systems` block is, not this
// editor's private setting.
const fs = require('fs');
const path = require('path');

const { emptyProfile, normalizeProfile } = require('./controllerProfile.cjs');

/**
 * The file's name.
 *
 * Prefixed `8bitscript.` so it sorts beside `8bitscript.config.ts` in a
 * directory listing and reads as part of the same project rather than as
 * some tool's dotfile. Not hidden, for the same reason: it is something a
 * person is allowed to open, read and hand-edit — every value in it is
 * plain text, and anything unreadable degrades to unbound (see
 * `normalizeProfile`) rather than to an error.
 */
const CONTROLLERS_FILE = '8bitscript.controllers.json';

/** Where a project's controllers file is, whether or not it exists yet. */
function controllersPath(dir) {
  return path.join(dir, CONTROLLERS_FILE);
}

/**
 * Read a project's controllers, normalized.
 *
 * Three failures collapse into the same answer — no file, unreadable
 * bytes, unparseable JSON — because all three mean the same thing to the
 * panel: this project has no controllers configured yet, which is a state
 * it already renders. The reason is handed back separately so a caller
 * that has somewhere to log it can, without the panel having to care.
 *
 * @param {string} dir the project directory
 * @returns {{ profile: object, exists: boolean, error: string|null }}
 */
function readProfile(dir) {
  const file = controllersPath(dir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // ENOENT is the ordinary case and not worth a message; anything else
    // (a permission, a directory where a file should be) is worth saying.
    return {
      profile: emptyProfile(),
      exists: false,
      error: error.code === 'ENOENT' ? null : `${file}: ${error.message}`,
    };
  }
  try {
    return { profile: normalizeProfile(JSON.parse(text)), exists: true, error: null };
  } catch (error) {
    return { profile: emptyProfile(), exists: true, error: `${file}: ${error.message}` };
  }
}

/**
 * Write a project's controllers.
 *
 * Normalized on the way out as well as on the way in, so the file never
 * holds a binding this cannot read back — a round trip through the panel
 * is the only thing that ever has to be true of it.
 *
 * Two spaces and a trailing newline: what every other JSON in this
 * repository is formatted as, and what a `git diff` of one changed binding
 * should show as one changed line.
 *
 * @param {string} dir the project directory
 * @param {object} profile
 * @returns {{ path: string, text: string }}
 */
function writeProfile(dir, profile) {
  const file = controllersPath(dir);
  const text = `${JSON.stringify(normalizeProfile(profile), null, 2)}\n`;
  fs.writeFileSync(file, text, 'utf8');
  return { path: file, text };
}

module.exports = {
  CONTROLLERS_FILE,
  controllersPath,
  readProfile,
  writeProfile,
};
