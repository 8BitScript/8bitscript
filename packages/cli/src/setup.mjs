// `8bs setup <target>` — install/configure what a target needs beyond what
// `8bs doctor` can offer as a single package-manager command. Right now
// that's just mega65 (Xemu built from source, plus the legally-obtained ROM
// pipeline docs/setup/mega65.md documents) — this file stays a thin
// dispatcher so the next source-built target follows the same shape.
const TARGETS = {
  mega65: () => import('./setup/mega65.mjs').then((m) => m.setupMega65),
};

function parseArgs(args) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--c64-forever') {
      options.c64ForeverPath = args[i + 1];
      i += 1;
    } else if (arg === '--rom-patch') {
      options.romPatchPath = args[i + 1];
      i += 1;
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    }
  }
  return { target: positionals[0], options };
}

/** @returns {Promise<number>} process exit code */
export async function setup(args) {
  const { target, options } = parseArgs(args);
  if (!target) {
    process.stderr.write(`Usage: 8bs setup <${Object.keys(TARGETS).join('|')}> [--c64-forever <msi>] [--rom-patch <zip>]\n`);
    return 2;
  }
  const load = TARGETS[target];
  if (!load) {
    process.stderr.write(`8bs setup: no setup available for '${target}'. Run '8bs doctor' for what's missing — docs/setup/.\n`);
    return 2;
  }
  const run = await load();
  const result = await run(options);
  return result.ok ? 0 : 1;
}
