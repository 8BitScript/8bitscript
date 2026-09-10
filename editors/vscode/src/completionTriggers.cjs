// The characters that ask the editor for completion mid-typing, kept in
// their own module (no `require('vscode')`) so a plain node test can pin
// this list without an extension host — see lsp.cjs's
// registerCompletionItemProvider call, and test/completionTriggers.test.cjs.
// Must track the language server's own completionProvider.triggerCharacters
// (packages/language-server/src/server.mjs): `:`/`<` for a type position,
// `.` for a named import's own namespace (`screen.bl` -> `blank`).
const COMPLETION_TRIGGER_CHARACTERS = [':', '<', '.'];

module.exports = { COMPLETION_TRIGGER_CHARACTERS };
