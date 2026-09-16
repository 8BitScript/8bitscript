// A project's programs, and the images that package them.
//
// One project can build more than one program — a desktop and the
// utilities beside it, the way GEOS ships a formatter and a copier as
// separate files on the same disk. Each is its own link, starting from its
// own `.8bs` entry, and each is named in `8bitscript.config.ts`:
//
//     programs: {
//       main:   { entry: 'src/main.8bs' },
//       format: { entry: 'src/tools/format.8bs', targets: ['c64', 'c128'] },
//     }
//
// The key is the output stem (`dist/format-c64-ntsc.prg`). `entry:
// 'src/main.8bs'` — every project through 0.10 — still works, and means
// exactly `programs: { main: { entry } }` with one difference kept on
// purpose: its stem is the entry's filename, as it always was, so no
// project's dist/ names move because a second spelling exists.
//
// An image is a container over programs — a `.d64` holding the three
// files above plus a font — written after they are built. This file
// validates the shape; nothing writes one yet, and `8bs build --release`
// says so rather than pretending.
import { basename, resolve } from 'node:path';

import { MACHINES, requiresProblems, sourceKindOf, stripSourceExtension } from '@8bitscript/compiler';

import { listedTargets } from './hardware.mjs';

const DEFAULT_ENTRY = 'src/main.8bs';
const DEFAULT_PROGRAM = 'main';

/** A program's name is also a filename stem, on every filesystem a build may land on. */
const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * The formats an image may take, per machine. A machine with none has no
 * disk to write: the NES's cartridge is the artifact, and the web's
 * bundle is. This list is the CLI's until each machine's catalog carries
 * its own, the way `media` already does for what a program is built as.
 */
export const IMAGE_FORMATS = Object.freeze({
  vic20: ['d64'],
  c64: ['d64', 'd71', 'd81'],
  pet: ['d64'],
  c128: ['d64', 'd71', 'd81'],
  cx16: ['d64'],
  mega65: ['d64', 'd81'],
  atari8: ['atr'],
  nes: [],
  web: [],
});

/** The CBM DOS directory entry's name field, in bytes — see artifact-name.mjs. */
const DISK_NAME_LIMIT = 16;

/**
 * @typedef {object} Program
 * @property {string} name        the key in `programs`, and the output stem unless `stemFromFilename`
 * @property {string} entry       the `.8bs` file the program starts from, as written
 * @property {boolean} stemFromFilename  true for the `entry:` spelling: the stem is the file's name
 * @property {string[]|null} targets     the machines this program builds for; null means the project's
 * @property {object} requires    fact floors: the project's, raised by the program's own
 */

/**
 * Every program the config declares, in declaration order.
 *
 * `entry` and `programs` are two spellings of one thing and cannot both be
 * given; every entry must be a `.8bs` file (a program starts from `.8bs`;
 * an `.8bx` declares composition and is imported — see build.mjs's
 * checkEntryKind for the long version); a program's `targets` must be a
 * subset of the project's; its `requires` may raise a floor and never lower
 * one.
 *
 * @param {object|null} config
 * @returns {{ ok: true, programs: Program[] } | { ok: false, error: string }}
 */
export function resolvePrograms(config) {
  const hasEntry = config?.entry !== undefined;
  const hasPrograms = config?.programs !== undefined;
  if (hasEntry && hasPrograms) {
    return {
      ok: false,
      error: "8bitscript.config.ts sets both `entry` and `programs`; `entry: 'src/main.8bs'` means "
        + "`programs: { main: { entry: 'src/main.8bs' } }`, so keep one",
    };
  }
  const projectTargets = listedTargets(config);
  const projectRequires = config?.requires && typeof config.requires === 'object' && !Array.isArray(config.requires)
    ? config.requires
    : {};

  if (!hasPrograms) {
    // The one-program spellings: `entry` (a path or the older per-machine
    // object) or nothing at all. Both keep the filename as the stem.
    return {
      ok: true,
      programs: [{
        name: DEFAULT_PROGRAM, entry: config?.entry ?? DEFAULT_ENTRY, stemFromFilename: true,
        targets: null, requires: projectRequires,
      }],
    };
  }

  const declared = config.programs;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    return { ok: false, error: "8bitscript.config.ts's `programs` must be an object of name → { entry, targets?, requires? }" };
  }
  const names = Object.keys(declared);
  if (names.length === 0) {
    return { ok: false, error: "8bitscript.config.ts's `programs` names no program; `main: { entry: 'src/main.8bs' }` is the usual one" };
  }
  const programs = [];
  for (const name of names) {
    const at = `8bitscript.config.ts's programs.${name}`;
    if (!PROGRAM_NAME.test(name)) {
      return { ok: false, error: `${at}: a program's name is its output filename, so letters, digits, '-' and '_' only` };
    }
    const spec = declared[name];
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return { ok: false, error: `${at} must be { entry: 'src/${name}.8bs', targets?, requires? }` };
    }
    if (typeof spec.entry !== 'string' || spec.entry.length === 0) {
      return { ok: false, error: `${at} needs an entry: the .8bs file the program starts from` };
    }
    const kind = sourceKindOf(spec.entry);
    if (kind !== '.8bs') {
      return {
        ok: false,
        error: kind === '.8bx'
          ? `${at}.entry is ${spec.entry}, a .8bx file; a program starts from a .8bs file that imports what the .8bx exports`
          : `${at}.entry is ${spec.entry}, which is not a .8bs file`,
      };
    }
    let targets = null;
    if (spec.targets !== undefined) {
      if (!Array.isArray(spec.targets) || spec.targets.length === 0 || !spec.targets.every((t) => typeof t === 'string')) {
        return { ok: false, error: `${at}.targets must be a non-empty array of machine names` };
      }
      for (const target of spec.targets) {
        if (!MACHINES.includes(target)) {
          return { ok: false, error: `${at}.targets names '${target}', which is no machine (${MACHINES.join(', ')})` };
        }
        if (projectTargets && !projectTargets.includes(target)) {
          return {
            ok: false,
            error: `${at}.targets names '${target}', but the project's targets are ${projectTargets.join(', ')}; a program builds for a subset of what its project lists`,
          };
        }
      }
      targets = [...spec.targets];
    }
    let requires = projectRequires;
    if (spec.requires !== undefined) {
      if (!spec.requires || typeof spec.requires !== 'object' || Array.isArray(spec.requires)) {
        return { ok: false, error: `${at}.requires must be an object of fact → the least of it the program needs` };
      }
      const problems = requiresProblems(spec.requires);
      if (problems.length > 0) return { ok: false, error: `${at}.requires: ${problems.join('; ')}` };
      for (const [key, need] of Object.entries(spec.requires)) {
        const floor = projectRequires[key];
        if (typeof floor === 'number' && typeof need === 'number' && need < floor) {
          return {
            ok: false,
            error: `${at}.requires sets ${key} to ${need}, below the project's ${floor}; a program may raise a floor, not lower one`,
          };
        }
      }
      requires = { ...projectRequires, ...spec.requires };
    }
    programs.push({ name, entry: spec.entry, stemFromFilename: false, targets, requires });
  }
  return { ok: true, programs };
}

/**
 * The program a command means: `--program <name>` when given, else `main`,
 * else the only one there is.
 *
 * @param {Program[]} programs
 * @param {string|undefined} name
 * @returns {{ ok: true, program: Program } | { ok: false, error: string }}
 */
export function selectProgram(programs, name) {
  if (name === undefined) {
    if (programs.length === 1) return { ok: true, program: programs[0] };
    const main = programs.find((p) => p.name === DEFAULT_PROGRAM);
    if (main) return { ok: true, program: main };
    return {
      ok: false,
      error: `this project has ${programs.length} programs (${programs.map((p) => p.name).join(', ')}) and none named main; say which with --program`,
    };
  }
  const program = programs.find((p) => p.name === name);
  if (program) return { ok: true, program };
  return { ok: false, error: `no program named '${name}' (programs: ${programs.map((p) => p.name).join(', ')})` };
}

/**
 * `--program <name>` out of a command's arguments: the name, and the two
 * indices it took, in the shape hardwareArgs() uses so the caller can
 * merge them into one `consumed` set.
 *
 * @param {string[]} args
 * @returns {{ ok: true, program: string|undefined, consumed: number[] } | { ok: false, error: string }}
 */
export function programArg(args) {
  const index = args.indexOf('--program');
  if (index < 0) return { ok: true, program: undefined, consumed: [] };
  const name = args[index + 1];
  if (name === undefined || name.startsWith('-')) return { ok: false, error: '--program expects a name' };
  return { ok: true, program: name, consumed: [index, index + 1] };
}

/**
 * The output stem for a program: its name, or — for the `entry:` spelling —
 * the entry file's own name with the source extension and, when the file
 * is one machine's twin (`main.nes.8bs`), that machine's suffix removed,
 * so `main.nes.8bs` builds to `main-nes.nes` and not `main.nes-nes.nes`.
 *
 * @param {Program} program
 * @param {string} entryPath   the resolved entry file (its twin, when one was picked)
 * @param {string} target
 */
export function programStem(program, entryPath, target) {
  if (!program.stemFromFilename) return program.name;
  let stem = basename(stripSourceExtension(entryPath));
  if (stem.endsWith(`.${target}`)) stem = stem.slice(0, -(target.length + 1));
  return stem;
}

/**
 * @typedef {object} Image
 * @property {string} name
 * @property {string} target
 * @property {string} format
 * @property {string} boot        the program written first
 * @property {Array<{ program?: string, path?: string, name: string, type: string }>} files
 */

/**
 * Every image the config declares, checked against the programs it
 * packages. An image names a target every listed program builds for and a
 * format that machine has; each file is a program (by name) or a path, with
 * an on-disk name of its own that fits the directory it lands in — CBM DOS
 * holds sixteen bytes and truncates the rest without a word, which is why
 * the host filename never leaks onto the disk. One program is the boot
 * program: the first directory entry, what `LOAD "*",8,1` loads.
 *
 * @param {object|null} config
 * @param {Program[]} programs
 * @returns {{ ok: true, images: Image[] } | { ok: false, error: string }}
 */
export function resolveImages(config, programs) {
  const declared = config?.images;
  if (declared === undefined) return { ok: true, images: [] };
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    return { ok: false, error: "8bitscript.config.ts's `images` must be an object of name → { target, format, boot, files }" };
  }
  const byName = new Map(programs.map((p) => [p.name, p]));
  const projectTargets = listedTargets(config);
  const images = [];
  for (const [name, spec] of Object.entries(declared)) {
    const at = `8bitscript.config.ts's images.${name}`;
    if (!PROGRAM_NAME.test(name)) return { ok: false, error: `${at}: an image's name is its filename, so letters, digits, '-' and '_' only` };
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, error: `${at} must be { target, format, boot, files }` };
    const { target, format, boot, files } = spec;
    if (typeof target !== 'string' || !MACHINES.includes(target)) {
      return { ok: false, error: `${at}.target must be a machine (${MACHINES.join(', ')})` };
    }
    if (projectTargets && !projectTargets.includes(target)) {
      return { ok: false, error: `${at}.target is '${target}', which the project's targets (${projectTargets.join(', ')}) do not list` };
    }
    const formats = IMAGE_FORMATS[target] ?? [];
    if (formats.length === 0) {
      return { ok: false, error: `${at}: the ${target} has no disk image to write; ${target === 'nes' ? 'its cartridge is the program' : 'its bundle is the program'}` };
    }
    if (typeof format !== 'string' || !formats.includes(format)) {
      return { ok: false, error: `${at}.format must be one of ${formats.join(', ')} for the ${target}` };
    }
    if (!Array.isArray(files) || files.length === 0) return { ok: false, error: `${at}.files must list at least one program or file` };
    const seenNames = new Set();
    const resolved = [];
    for (const [i, file] of files.entries()) {
      const fat = `${at}.files[${i}]`;
      if (!file || typeof file !== 'object') return { ok: false, error: `${fat} must be { program, name } or { path, name }` };
      const isProgram = typeof file.program === 'string';
      const isPath = typeof file.path === 'string';
      if (isProgram === isPath) return { ok: false, error: `${fat} names either a program or a path, not ${isProgram ? 'both' : 'neither'}` };
      if (isProgram) {
        const program = byName.get(file.program);
        if (!program) return { ok: false, error: `${fat}.program is '${file.program}', which is no program (${[...byName.keys()].join(', ')})` };
        if (program.targets && !program.targets.includes(target)) {
          return { ok: false, error: `${fat}: program '${file.program}' does not build for the ${target} (its targets: ${program.targets.join(', ')})` };
        }
      }
      if (typeof file.name !== 'string' || file.name.length === 0) {
        return { ok: false, error: `${fat} needs a name: what the file is called on the disk, apart from the file on the host` };
      }
      if (Buffer.byteLength(file.name, 'latin1') > DISK_NAME_LIMIT) {
        return { ok: false, error: `${fat}.name '${file.name}' is longer than the ${DISK_NAME_LIMIT} characters a directory entry holds` };
      }
      if (seenNames.has(file.name)) return { ok: false, error: `${fat}.name '${file.name}' is already used in this image` };
      seenNames.add(file.name);
      const type = file.type ?? (isProgram ? 'prg' : 'seq');
      if (type !== 'prg' && type !== 'seq') return { ok: false, error: `${fat}.type must be 'prg' or 'seq'` };
      resolved.push({ ...(isProgram ? { program: file.program } : { path: file.path }), name: file.name, type });
    }
    if (typeof boot !== 'string' || !resolved.some((f) => f.program === boot)) {
      return { ok: false, error: `${at}.boot must name one of the image's programs (${resolved.filter((f) => f.program).map((f) => f.program).join(', ') || 'none listed'})` };
    }
    images.push({ name, target, format, boot, files: resolved });
  }
  return { ok: true, images };
}

/** Where an image would be written: `dist/<name>.<format>`. */
export function imageOutFile(image, cwd = process.cwd()) {
  return resolve(cwd, 'dist', `${image.name}.${image.format}`);
}
