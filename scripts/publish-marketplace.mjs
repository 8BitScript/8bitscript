#!/usr/bin/env node
// Upload a VSIX to the Visual Studio Marketplace using the same REST
// endpoints vsce uses, but with a 10-minute wait. vsce's
// azure-devops-node-api client gives up at 180 seconds. That clock is
// the gallery sitting silent after the upload, not the size of the
// package — a 200 KB VSIX is on the wire in a second.
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VSIX_DIR = resolve('/tmp');
const MARKETPLACE = 'https://marketplace.visualstudio.com';
const API = '7.2-preview.2';
const WAIT_MS = 10 * 60 * 1000;

// argv is untrusted (CI, a shell, an agent). Take only the filename and
// resolve it under /tmp — the directory release.yml already writes to —
// so `..` and absolute paths cannot pick a file elsewhere.
function resolveVsixPath(input) {
  const fileName = basename(input ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.vsix$/.test(fileName)) {
    process.stderr.write('usage: node scripts/publish-marketplace.mjs <file.vsix>\n');
    process.exit(2);
  }
  const resolved = resolve(VSIX_DIR, fileName);
  if (!resolved.startsWith(VSIX_DIR + sep)) {
    process.stderr.write('VSIX path is outside /tmp.\n');
    process.exit(2);
  }
  return resolved;
}

const vsixPath = resolveVsixPath(process.argv[2]);

// Sign-in: a Microsoft Entra access token (VSCE_AAD_TOKEN, from GitHub OIDC
// through azure/login) wins over a personal access token (VSCE_PAT). Azure
// DevOps retires global PATs on 2026-12-01. vsce's own
// `--azure-credential` path hands the Entra token to the same client it
// uses for a PAT (`getBasicHandler('OAuth', token)` in @vscode/vsce
// out/util.js), so the gallery sees `Basic base64("OAuth:<token>")` for
// both; this script does the same instead of a Bearer header vsce never
// sends. The token is never logged.
const aadToken = process.env.VSCE_AAD_TOKEN;
const pat = process.env.VSCE_PAT;
const credential = aadToken || pat;
if (!credential) {
  process.stderr.write('Neither VSCE_AAD_TOKEN nor VSCE_PAT is set.\n');
  process.exit(1);
}
process.stdout.write(
  `Marketplace sign-in: ${aadToken ? 'Microsoft Entra token' : 'personal access token'}.\n`,
);

const pkg = JSON.parse(await readFile(join(ROOT, 'editors/vscode/package.json'), 'utf8'));
const publisher = pkg.publisher;
const name = pkg.name;
const version = pkg.version;
const auth = `Basic ${Buffer.from(`OAuth:${credential}`).toString('base64')}`;

async function gallery(method, path, { body, timeoutMs = WAIT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${MARKETPLACE}${path}`, {
      method,
      headers: {
        Authorization: auth,
        Accept: `application/json;api-version=${API}`,
        ...(body
          ? {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(body.byteLength),
            }
          : {}),
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function alreadyHasVersion(extension) {
  return (extension.versions ?? []).some((entry) => entry.version === version);
}

const vsix = await readFile(vsixPath);
const bytes = statSync(vsixPath).size;
process.stdout.write(
  `Publishing ${publisher}.${name} v${version} (${Math.round(bytes / 1024)} KB). ` +
    `The gallery often waits minutes after the upload; vsce would time out at 180s.\n`,
);

// No timeoutMs override: this GET hits the same gallery backend as the
// publish call below, and it has gone silent for 30s+ in practice
// (v0.1.3's release run: three straight AbortErrors here, upload never
// even attempted) — a metadata read isn't cheaper for an unresponsive
// server, so it gets the same WAIT_MS budget.
const existing = await gallery(
  'GET',
  `/_apis/gallery/publishers/${publisher}/extensions/${name}?flags=1`,
);

if (existing.status === 200) {
  const json = await existing.json();
  if (alreadyHasVersion(json)) {
    process.stdout.write(`Version ${version} is already on the Marketplace. Skipping.\n`);
    process.exit(0);
  }
} else if (existing.status !== 404) {
  process.stderr.write(`GET extension failed: ${existing.status} ${await existing.text()}\n`);
  process.exit(1);
}

const started = Date.now();
const published =
  existing.status === 404
    ? await gallery('POST', `/_apis/gallery/extensions`, { body: vsix })
    : await gallery(
        'PUT',
        `/_apis/gallery/publishers/${publisher}/extensions/${name}`,
        { body: vsix },
      );

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
if (published.status === 409) {
  process.stdout.write(`Version ${version} is already published (${elapsed}s). Skipping.\n`);
  process.exit(0);
}
if (!published.ok) {
  process.stderr.write(
    `Marketplace ${published.status} after ${elapsed}s: ${await published.text()}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Published ${publisher}.${name} v${version} in ${elapsed}s.\n` +
    `https://marketplace.visualstudio.com/items?itemName=${publisher}.${name}\n`,
);
