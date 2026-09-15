#!/usr/bin/env node
// The root package.json is private and outside pnpm-workspace.yaml's
// `packages/*`/`editors/*` globs, so changesets never sees it as a
// workspace member and never bumps its version — it drifted at 0.1.0
// while every published package moved on. Keeps it lockstep with the
// fixed group's version as part of the version-bump step, the same way
// sync-studio-version.mjs keeps studio.8bs's VERSION literal in sync.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8'));
const rootPath = join(ROOT, 'package.json');
const root = JSON.parse(readFileSync(rootPath, 'utf8'));

root.version = cli.version;
writeFileSync(rootPath, `${JSON.stringify(root, null, 2)}\n`);
process.stdout.write(`package.json -> ${cli.version}\n`);
