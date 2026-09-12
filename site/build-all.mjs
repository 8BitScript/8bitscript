// Build the documentation site once as the latest release at `/` and once
// as a frozen snapshot at `/<version>/`, then write versions.json for the
// header dropdown. Pagefind indexes the latest tree before version
// snapshots are added, so `/` search stays on the current release.
//
// A snapshot is built from that tag's own `docs/` and `site/nav.mjs`,
// extracted out of git into a scratch directory — not from the working tree.
// Rendering the working tree under an older number is how the site spent its
// first fifteen releases publishing today's pages at fifteen URLs; `/0.1.3/`
// has to be what 0.1.3 shipped or the picker is decoration.
//
// The renderer is always the current one. An old tag's `site/build.mjs`
// predates `DOCS_BASE` and would emit root-absolute URLs into a subdirectory,
// so only that tag's content travels forward, never its builder.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { build } from './build.mjs';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'dist', 'site');
// Scratch space for the extracted tags. Under dist/ so .gitignore already
// covers it, and removed once every snapshot has been rendered.
const WORK = join(ROOT, 'dist', 'versions');

function majorOf(version) {
  return version.split('.')[0] ?? '0';
}

function snapshotPath(version) {
  return version === 'dev' ? '/dev' : `/${version}`;
}

async function listGitTags(cwd = ROOT) {
  const { stdout } = await exec('git', ['tag', '-l', 'v*'], { cwd });
  return stdout
    .split(/\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => t.replace(/^v/, ''))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * `v*` tags in this clone, fetching them first when the clone has none.
 *
 * Cloudflare Workers Builds clones without tags (GitHub Actions already
 * uses `fetch-depth: 0`). Silently building a one-version site from that
 * is how the picker spent fifteen releases pointing at today's pages; fetch
 * before giving up, so the production deploy still snapshots what each tag
 * shipped.
 */
async function gitTags(cwd = ROOT) {
  const listed = await listGitTags(cwd);
  if (listed.length > 0) return listed;

  console.log('No v* tags in this clone; fetching from the remote.');
  try {
    await exec('git', ['fetch', '--tags', '--force', '--quiet'], {
      cwd,
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    // No remote, or the fetch was refused. The empty-list check in buildAll
    // still throws if nothing arrived.
  }

  return listGitTags(cwd);
}

/** Whether `path` exists in the tree at `ref`. Works for files and directories. */
async function existsAt(ref, path) {
  try {
    await exec('git', ['cat-file', '-e', `${ref}:${path}`], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract a tag's `docs/` (and its `site/nav.mjs`, when it has one) into a
 * scratch directory, and return the paths to hand the builder.
 *
 * Returns null when the tag carries no `docs/` at all — a release from before
 * the documentation set existed has nothing to snapshot.
 */
async function extractDocs(version) {
  const ref = `v${version}`;
  if (!(await existsAt(ref, 'docs'))) return null;

  const dir = join(WORK, version);
  const tar = join(WORK, `${version}.tar`);
  const paths = ['docs'];
  const hasNav = await existsAt(ref, 'site/nav.mjs');
  if (hasNav) paths.push('site/nav.mjs');

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await exec('git', ['archive', '--format=tar', '-o', tar, ref, '--', ...paths], { cwd: ROOT });
  await exec('tar', ['-xf', tar, '-C', dir]);
  await rm(tar, { force: true });

  return { docs: join(dir, 'docs'), nav: hasNav ? join(dir, 'site', 'nav.mjs') : '' };
}

async function pagefind(dir) {
  await exec('pnpm', ['exec', 'pagefind', '--site', dir], { cwd: ROOT });
}

async function buildTree({ version, base, out, src = '', nav = '' }) {
  process.env.DOCS_VERSION = version;
  process.env.DOCS_BASE = base;
  process.env.DOCS_OUT = out;
  process.env.DOCS_SRC = src;
  process.env.DOCS_NAV = nav;
  await build();
  await pagefind(resolve(ROOT, out));
}

async function buildAll() {
  const pkg = JSON.parse(await readFile(join(ROOT, 'packages/cli/package.json'), 'utf8'));
  const current = pkg.version;
  const tagged = await gitTags();
  if (tagged.length === 0) {
    // Silently degrading here is what published a one-version site for fifteen
    // releases: a shallow clone has no tags, the snapshot loop had nothing to
    // iterate, and versions.json said so without anyone reading it. Stop instead.
    throw new Error(
      'No v* tags found. The version snapshots are built from tags, so a shallow ' +
        'clone or a tagless mirror cannot build this site. Fetch tags ' +
        '(`git fetch --tags`, or actions/checkout with `fetch-depth: 0`) and retry.',
    );
  }
  const versions = tagged.includes(current) ? tagged : [...tagged, current];

  await rm(SITE, { recursive: true, force: true });
  await rm(WORK, { recursive: true, force: true });
  await buildTree({ version: current, base: '', out: 'dist/site' });

  const built = [];
  for (const version of versions) {
    // The current version is only tagged once the release lands; until then its
    // snapshot is the working tree, which is also what `/` just rendered.
    const extracted = tagged.includes(version) ? await extractDocs(version) : null;
    if (tagged.includes(version) && !extracted) {
      console.warn(`Skipping ${version}: v${version} has no docs/ to snapshot.`);
      continue;
    }

    // A tag's content is immutable, so a snapshot that will not render under
    // today's builder — front matter this parser no longer accepts, a link the
    // checker now rejects — would wedge every future deploy if it threw. Drop
    // that one version, say so, and leave it out of versions.json rather than
    // letting one old tag stop the site from publishing. `/` is not in this
    // loop: a working-tree failure still stops the build.
    try {
      await buildTree({
        version,
        base: snapshotPath(version),
        out: join('dist', 'site', version),
        src: extracted?.docs ?? '',
        nav: extracted?.nav ?? '',
      });
      built.push(version);
    } catch (error) {
      console.warn(`Skipping ${version}: snapshot failed to build (${error.message})`);
      await rm(join(SITE, version), { recursive: true, force: true });
    }
  }

  await rm(WORK, { recursive: true, force: true });

  const manifest = {
    current,
    versions: built
      .slice()
      .reverse()
      .map((version) => ({
        version,
        label: version,
        major: majorOf(version),
        path: snapshotPath(version),
        latest: version === current,
      })),
  };

  await writeFile(join(SITE, 'versions.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifest.versions.length} version(s); latest is ${current}.`);
}

export { gitTags, buildAll };

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  await buildAll();
}
