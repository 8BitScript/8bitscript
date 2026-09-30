// Fire-and-forget for async work started from a VS Code event listener or
// webview message handler: those have no caller to hand a rejection to, so
// an uncaught one would be an unhandled promise rejection. `quietly` runs
// `work` (a throw is caught the same as a rejection), logs a failure under
// `label`, and hands it to `report` when the user should see it too. The
// promise it returns never rejects; a caller that drops it writes
// `void quietly(...)` to say so (SonarCloud's S9383 cannot see the catch).
'use strict';

function quietly(label, work, report) {
  return Promise.resolve()
    .then(work)
    .catch((error) => {
      console.error(`${label}:`, error);
      if (report) report(error);
    });
}

module.exports = { quietly };
