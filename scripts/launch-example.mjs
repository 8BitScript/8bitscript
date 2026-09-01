#!/usr/bin/env node
// Interactive example launcher.
//
// Lists every project under examples/, lets you pick one and then pick which
// target to run it on, and hands off to the real `8bs run <target>` in that
// example's own directory — the same command an outside consumer would type.
// Loops back to the menu after each run so you can try another combination
// without restarting the script.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES_DIR = join(ROOT, 'examples');
const ALL_TARGETS = ['vic20-ntsc', 'vic20-pal', 'c64-ntsc', 'c64-pal', 'web'];

async function loadConfig(dir) {
  const path = join(dir, '8bs.config.ts');
  if (!existsSync(path)) return null;
  const module = await import(pathToFileURL(path).href);
  return module.default ?? null;
}

async function discoverExamples() {
  const examples = [];
  for (const name of readdirSync(EXAMPLES_DIR).sort()) {
    const dir = join(EXAMPLES_DIR, name);
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    const config = await loadConfig(dir);
    const targets = config?.targets ?? ALL_TARGETS;
    examples.push({ name, dir, description: pkg.description ?? '', targets });
  }
  return examples;
}

function localBin(dir) {
  const bin = join(dir, 'node_modules', '.bin', '8bs');
  return existsSync(bin) ? bin : join(ROOT, 'packages', 'cli', 'bin', '8bs.mjs');
}

/** @returns {Promise<number>} exit code of the `8bs run` child process */
function runExample(example, target) {
  const bin = localBin(example.dir);
  const command = bin.endsWith('.mjs') ? process.execPath : bin;
  const args = bin.endsWith('.mjs') ? [bin, 'run', target] : ['run', target];
  process.stdout.write(`\n> 8bs run ${target}  (${example.name})\n\n`);
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: example.dir, stdio: 'inherit' });
    child.on('error', (error) => {
      process.stderr.write(`launch-example: failed to start 8bs: ${error.message}\n`);
      resolvePromise(1);
    });
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

async function pick(rl, prompt, items, format) {
  process.stdout.write(`\n${prompt}\n`);
  items.forEach((item, i) => process.stdout.write(`  ${i + 1}) ${format(item)}\n`));
  for (;;) {
    const answer = (await rl.question(`> `)).trim();
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < items.length) return items[index];
    process.stdout.write(`Enter a number between 1 and ${items.length} (or Ctrl+C to quit).\n`);
  }
}

// A fresh readline.Interface is opened per interactive segment and closed
// before spawning a child with stdio: 'inherit' — sharing one long-lived
// interface with an inherited child stdin causes the two to fight over the
// same fd and readline's `question()` promise never settles.
async function ask(fn) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

async function main() {
  const examples = await discoverExamples();
  if (examples.length === 0) {
    process.stderr.write('launch-example: no examples found under examples/\n');
    return 1;
  }

  for (;;) {
    const { example, target } = await ask(async (rl) => {
      const example = await pick(
        rl,
        'Which example?',
        examples,
        (e) => `${e.name}${e.description ? ` — ${e.description}` : ''}`,
      );
      const target = await pick(
        rl,
        `Which target for ${example.name}? (${example.targets.join(', ')})`,
        example.targets,
        (t) => t,
      );
      return { example, target };
    });

    await runExample(example, target);

    const again = await ask((rl) => rl.question('\nRun another? [Y/n] '));
    if (again.trim().toLowerCase().startsWith('n')) return 0;
  }
}

process.exitCode = await main();
