// A tiny process entry point so the test below can spawn a real server over
// real stdio, the same way `8bs lsp --stdio` does for an editor.
import { start } from '../src/server.mjs';

start();
