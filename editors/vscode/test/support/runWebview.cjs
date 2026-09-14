// Runs a webview media/*.js file for real in a vm context so node's
// coverage collector attributes the lines it executes back to the actual
// file — the filename passed to vm.Script must be the file's real
// absolute path, or V8 has nothing to match the coverage report against.
'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const { createDomStub } = require('./domStub.cjs');

/**
 * @param {string[]} files absolute paths, run in order in one shared context
 *   (mirrors <script> tags sharing one page — hardware.js's functions must
 *   already be globals by the time system.js calls them)
 * @param {(dom: ReturnType<typeof createDomStub>) => void} [seed] set up
 *   elements the script reaches for at load time, before it runs
 */
function runWebviewScripts(files, seed) {
  const dom = createDomStub();
  const posted = [];
  if (seed) seed(dom);
  const sandbox = {
    document: dom.document,
    window: dom.window,
    console,
    acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message) }),
  };
  vm.createContext(sandbox);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const script = new vm.Script(source, { filename: file });
    script.runInContext(sandbox);
  }
  return { dom, sandbox, posted };
}

module.exports = { runWebviewScripts };
