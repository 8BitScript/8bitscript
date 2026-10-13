// The names under the launcher's run buttons: which editor a Preview opens
// in, and which browser a Browser run opens. Both are facts about this
// computer, not about the program, so they are worked out once per window
// and only ever shown — nothing decides anything from them. A name that
// cannot be found is null, and the button simply has no second line.
//
// The browser is the system's handler for https: what `8bs run --web`'s
// open() will actually launch. Each platform keeps that somewhere
// different, and each is read with the platform's own tool:
//
//   macOS    LaunchServices' handler list, as JSON via `plutil`
//   Windows  the https UserChoice ProgId, via `reg query`
//   Linux    `xdg-settings get default-web-browser` (a .desktop file name)
'use strict';

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');

/** The editor's own name, short: "Cursor", "VS Code", "VS Code Insiders", or whatever the host calls itself. */
function editorName(appName) {
  const name = String(appName || '').trim();
  if (!name) return null;
  if (/^Visual Studio Code\b/.test(name)) return name.replace(/^Visual Studio Code/, 'VS Code').replace(/\s*-\s*/, ' ');
  return name;
}

// Bundle ids, ProgId prefixes and .desktop stems, each to the name the
// browser goes by. Anything not here shows its own id trimmed to a word
// rather than nothing — it is still the right browser, just not prettily.
const MAC = {
  'com.apple.safari': 'Safari',
  'com.apple.safaritechnologypreview': 'Safari Preview',
  'com.google.chrome': 'Chrome',
  'com.google.chrome.beta': 'Chrome Beta',
  'com.google.chrome.canary': 'Chrome Canary',
  'org.chromium.chromium': 'Chromium',
  'org.mozilla.firefox': 'Firefox',
  'org.mozilla.firefoxdeveloperedition': 'Firefox Dev',
  'org.mozilla.nightly': 'Firefox Nightly',
  'com.microsoft.edgemac': 'Edge',
  'com.brave.browser': 'Brave',
  'company.thebrowser.browser': 'Arc',
  'com.operasoftware.opera': 'Opera',
  'com.vivaldi.vivaldi': 'Vivaldi',
  'app.zen-browser.zen': 'Zen',
  'com.kagi.kagimacos': 'Orion',
  'ai.perplexity.comet': 'Comet',
};
const WINDOWS = [
  [/^ChromeHTML/i, 'Chrome'],
  [/^MSEdgeHTM/i, 'Edge'],
  [/^FirefoxURL/i, 'Firefox'],
  [/^BraveHTML/i, 'Brave'],
  [/^Opera/i, 'Opera'],
  [/^VivaldiHTM/i, 'Vivaldi'],
  [/^ArcHTML/i, 'Arc'],
  [/^IE\.HTTP/i, 'Internet Explorer'],
];
const LINUX = [
  [/^google-chrome/, 'Chrome'],
  [/^chromium/, 'Chromium'],
  [/firefox/, 'Firefox'],
  [/^brave/, 'Brave'],
  [/^microsoft-edge/, 'Edge'],
  [/^vivaldi/, 'Vivaldi'],
  [/^opera/, 'Opera'],
  [/epiphany|org\.gnome\.Epiphany/i, 'Web'],
];

/** The https handler's name from LaunchServices' handler list (already parsed from JSON). */
function macBrowser(plist) {
  const handlers = Array.isArray(plist?.LSHandlers) ? plist.LSHandlers : [];
  const https = handlers.find((h) => h && h.LSHandlerURLScheme === 'https')
    ?? handlers.find((h) => h && h.LSHandlerURLScheme === 'http');
  const id = String(https?.LSHandlerRoleAll ?? '').toLowerCase();
  // No entry at all means the user never changed it: Safari.
  if (!id) return 'Safari';
  return MAC[id] ?? lastWord(id);
}

/** The https handler's name from `reg query ... /v ProgId` output. */
function windowsBrowser(output) {
  const match = /ProgId\s+REG_SZ\s+(\S+)/i.exec(String(output || ''));
  if (!match) return null;
  const hit = WINDOWS.find(([pattern]) => pattern.test(match[1]));
  return hit ? hit[1] : match[1].replace(/(HTML?|URL|\.HTTPS?)$/i, '') || null;
}

/** The default browser's name from `xdg-settings get default-web-browser` (e.g. "firefox.desktop"). */
function linuxBrowser(output) {
  const stem = String(output || '').trim().replace(/\.desktop$/, '');
  if (!stem) return null;
  const hit = LINUX.find(([pattern]) => pattern.test(stem));
  return hit ? hit[1] : capitalize(lastWord(stem));
}

function lastWord(id) {
  const word = id.split(/[.\-_]/).filter(Boolean).pop() || id;
  return capitalize(word);
}

function capitalize(word) {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 3000, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

/**
 * The default browser's name on this computer, or null when it cannot be
 * told. Never throws, and gives up after a few seconds.
 *
 * @param {{ platform?: string, home?: string, exec?: (file: string, args: string[]) => Promise<string|null> }} [options]
 */
async function defaultBrowser({ platform = process.platform, home = os.homedir(), exec = run } = {}) {
  try {
    if (platform === 'darwin') {
      const file = path.join(home, 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist');
      const json = await exec('plutil', ['-convert', 'json', '-o', '-', file]);
      // No file: nothing was ever changed, so the system default.
      return json === null ? 'Safari' : macBrowser(JSON.parse(json));
    }
    if (platform === 'win32') {
      return windowsBrowser(await exec('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']));
    }
    return linuxBrowser(await exec('xdg-settings', ['get', 'default-web-browser']));
  } catch {
    return null;
  }
}

module.exports = { defaultBrowser, editorName, linuxBrowser, macBrowser, windowsBrowser };
