// `8bs project --json` is what the editor builds its work-unit controls
// from (docs/project/units.md), and `--define` is how a unit gets its
// values; both are exercised the way the editor uses them, as the CLI in a
// project directory, against sources the compiler really reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/8bs.mjs', import.meta.url));
// @8bitscript/* resolves through this checkout, as `--checkout` does.
const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Run the CLI in `dir`; never throws on a non-zero exit. */
async function cli(dir, args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args, '--checkout', CHECKOUT], { cwd: dir });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const READS_DEFINES = `import { screen } from "@8bitscript/screen";
import { text } from "@8bitscript/text";
const SEED: utinyint = #define("SEED", 10);
const FORCE_BONUS: bool = #define("FORCE_BONUS", false);
export function main(): void {
    screen.blank();
    text.printNumber(0, SEED, 3);
    if (FORCE_BONUS) {
        text.print(40, "BONUS");
    }
    text.releaseCursor();
}
`;

const READS_NONE = `import { screen } from "@8bitscript/screen";
import { text } from "@8bitscript/text";
export function main(): void {
    screen.blank();
    text.print(0, "PLAIN");
    text.releaseCursor();
}
`;

/** A project with a plain program and one that reads two defines and is configured for them. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), '8bs-project-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'main.8bs'), READS_NONE);
  writeFileSync(join(dir, 'src', 'bonus.8bs'), READS_DEFINES);
  writeFileSync(join(dir, '8bitscript.config.8bs'), `export default {
  programs: {
    main: { entry: 'src/main.8bs', title: 'The game', group: 'Play' },
    bonus: {
      entry: 'src/bonus.8bs', title: 'Bonus round', description: 'Starts in the bonus.', group: 'Labs', targets: ['pet'],
      define: { SEED: 7, FORCE_BONUS: { value: true, description: 'start in the bonus' }, GHOST: 3 },
    },
  },
  targets: ['pet', 'c64'],
};
`);
  return dir;
}

test('project --json describes the programs, their display fields, and the defines read from the source', async () => {
  const dir = fixture();
  const result = await cli(dir, ['project', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.version, 1);
  assert.equal(info.hasConfig, true);
  assert.match(info.configPath, /8bitscript\.config\.8bs$/);
  assert.equal(info.configError, null);
  assert.equal(info.targetsListed, true);
  assert.deepEqual(info.targets.map((t) => t.id), ['pet', 'c64']);
  assert.deepEqual(info.problems, []);

  const [main, bonus] = info.programs;
  assert.deepEqual([main.name, main.title, main.group, main.description], ['main', 'The game', 'Play', null]);
  assert.deepEqual(main.targets, ['pet', 'c64']);
  assert.equal(main.targetsDeclared, null);
  assert.equal(main.entryExists, true);
  assert.deepEqual(main.defines, [], 'a program that reads no define lists none');
  assert.equal(main.definesRead, true);

  assert.deepEqual([bonus.name, bonus.title, bonus.group, bonus.description], ['bonus', 'Bonus round', 'Labs', 'Starts in the bonus.']);
  assert.deepEqual(bonus.targets, ['pet'], 'a program\'s own targets narrow the project\'s');
  assert.deepEqual(bonus.targetsDeclared, ['pet']);
  assert.equal(bonus.definesReadOn, 'pet');
  assert.deepEqual(bonus.defines, [
    { name: 'SEED', kind: 'int', default: 10, value: 7, description: null, source: 'source' },
    { name: 'FORCE_BONUS', kind: 'bool', default: false, value: true, description: 'start in the bonus', source: 'source' },
    { name: 'GHOST', kind: 'int', default: null, value: 3, description: null, source: 'config-only' },
  ], 'source defaults come from the compiler, the values from the config, and a name nothing reads is marked');
  assert.deepEqual(bonus.problems, []);
});

test('project --no-defines does not link the programs and says so', async () => {
  const dir = fixture();
  const info = JSON.parse((await cli(dir, ['project', '--json', '--no-defines'])).stdout);
  const bonus = info.programs.find((p) => p.name === 'bonus');
  assert.equal(bonus.definesRead, false);
  assert.deepEqual(bonus.defines.map((d) => [d.name, d.source]), [['SEED', 'config-only'], ['FORCE_BONUS', 'config-only'], ['GHOST', 'config-only']]);
});

test('a directory with no config is described, not refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-project-empty-'));
  const result = await cli(dir, ['project', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.hasConfig, false);
  assert.equal(info.configPath, null);
  assert.deepEqual(info.programs.map((p) => p.name), ['main'], 'the one program every project has');
  assert.equal(info.programs[0].entryExists, false);
  assert.match(info.programs[0].problems[0], /does not exist/);
});

test('a config that cannot be loaded is exit 1 with the JSON still printed', async () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-project-broken-'));
  writeFileSync(join(dir, '8bitscript.config.8bs'), 'export default {{{');
  const result = await cli(dir, ['project', '--json']);
  assert.equal(result.code, 1);
  const info = JSON.parse(result.stdout);
  assert.equal(info.hasConfig, true);
  assert.match(info.configError, /could not be loaded/);
});

test('a programs block with a mistake costs the reader its programs, not the whole picture', async () => {
  const dir = mkdtempSync(join(tmpdir(), '8bs-project-bad-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, '8bitscript.config.8bs'), `export default { programs: { a: { entry: 'src/a.8bs', define: { seed: 1 } } }, targets: ['pet'] };\n`);
  const result = await cli(dir, ['project', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.deepEqual(info.programs, []);
  assert.equal(info.problems[0].scope, 'programs');
  assert.match(info.problems[0].message, /programs\.a\.define\.seed/);
  assert.deepEqual(info.targets.map((t) => t.id), ['pet'], 'the targets are still true');
});

test('project refuses what it does not take', async () => {
  const dir = fixture();
  const result = await cli(dir, ['project', '--bogus']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unexpected --bogus/);
});

test('project\'s table form names each program and the --define it takes', async () => {
  const dir = fixture();
  const result = await cli(dir, ['project']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /bonus — Bonus round {2}\[Labs\]/);
  assert.match(result.stdout, /--define SEED=7 {2}\(the source says 10\)/);
  assert.match(result.stdout, /--define GHOST=3 {2}\(no #define reads this\)/);
});

test('--define reaches the build: a different value is a different build, recorded in the last-run report', async () => {
  const dir = fixture();
  const plain = await cli(dir, ['build', '--target', 'pet', '--program', 'bonus']);
  assert.equal(plain.code, 0, plain.stderr + plain.stdout);
  const report = () => JSON.parse(readFileSync(join(dir, 'dist', '.8bs-last-pet.json'), 'utf8'));
  assert.deepEqual(report().defines, { SEED: 7, FORCE_BONUS: true }, 'the config\'s values over the source defaults');
  const prg = () => readFileSync(join(dir, 'dist', 'bonus-pet.prg'));
  const configured = prg();
  const handed = await cli(dir, ['build', '--target', 'pet', '--program', 'bonus', '--define', 'SEED=42', '--define', 'FORCE_BONUS=false']);
  assert.equal(handed.code, 0, handed.stderr + handed.stdout);
  assert.deepEqual(report().defines, { SEED: 42, FORCE_BONUS: false }, 'the command line over the config');
  assert.notDeepEqual(prg(), configured, 'a different value is a different build');
});

test('the drift guard: the defines project --json finds are the ones a real build reports', async () => {
  const dir = fixture();
  const info = JSON.parse((await cli(dir, ['project', '--json'])).stdout);
  const found = Object.fromEntries(info.programs.find((p) => p.name === 'bonus').defines
    .filter((d) => d.source === 'source').map((d) => [d.name, d.value]));
  await cli(dir, ['build', '--target', 'pet', '--program', 'bonus']);
  const built = JSON.parse(readFileSync(join(dir, 'dist', '.8bs-last-pet.json'), 'utf8')).defines;
  assert.deepEqual(built, found);
});

test('a name no #define reads is an error naming the nearest one; a value of the wrong kind is 8BS1048', async () => {
  const dir = fixture();
  const typo = await cli(dir, ['build', '--target', 'pet', '--program', 'bonus', '--define', 'SEDD=1']);
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /--define SEDD: program 'bonus' has no #define\("SEDD", …\) — it reads SEED, FORCE_BONUS; did you mean SEED\?/);
  const plain = await cli(dir, ['build', '--target', 'pet', '--program', 'main', '--define', 'SEED=1']);
  assert.equal(plain.code, 1);
  assert.match(plain.stderr, /it reads no #define at all/);
  const kind = await cli(dir, ['build', '--target', 'pet', '--program', 'bonus', '--define', 'SEED=true']);
  assert.equal(kind.code, 1);
  assert.match(kind.stdout + kind.stderr, /8BS1048/);
  const ghost = await cli(dir, ['build', '--target', 'pet', '--program', 'bonus']);
  assert.equal(ghost.code, 0);
  assert.match(ghost.stderr, /programs\.bonus\.define names GHOST, which no #define in the program reads/);
});

test('check takes --define too, so the check sees the build it is checking', async () => {
  const dir = fixture();
  const ok = await cli(dir, ['check', 'src/bonus.8bs', '--define', 'SEED=42']);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  const wrong = await cli(dir, ['check', 'src/bonus.8bs', '--define', 'SEED=true']);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stdout, /8BS1048/);
  const malformed = await cli(dir, ['check', 'src/bonus.8bs', '--define', 'seed=1']);
  assert.equal(malformed.code, 2);
  assert.match(malformed.stderr, /capital letters/);
});
