// Native 6502 sources on the machines that LINK them: the code half of
// `ir.nativeSources`, for every target that is not the NES.
//
// A package may ship hand-written assembly beside its `.8bs` sources
// (`"8bitscript".native` in its package.json; the resolver carries the
// paths through to `ir.nativeSources`). On the NES that assembly is the
// CHR-ROM's tile patterns — bytes of the FILE, assembled by
// mos/chr-nes.ts into the image and never executed. Everywhere else it is
// CODE: @8bitscript/c64's `native/6502/raster.s` is the CPU-vector stub
// every C64 program needs and the raster-interrupt handler only some do,
// and both have to join the one program link() assembles so that a
// `jsr __8bs_c64_raster_install` inside an `asm6502` block resolves the
// same way a call to a lowered function does.
//
// The shape read here is the one raster.s is written in, and nothing more:
//
//     .section .init.250,"ax",@progbits      run before main(), always
//     .section .text.<symbol>,"ax",@progbits kept only if reached
//     .global <symbol>                       leading, naming a label the
//                                            section defines
//
// followed by ordinary instructions mos/asm/parse.ts reads (with the
// `0x`-hex, `#<label`/`#>label` and `label+N` spellings those sources
// use). `.init.N` sections from every source are concatenated in
// ascending N and spliced ahead of the entry function's own body.
// `.text.<symbol>` sections are mark-and-swept: one survives when its
// public symbol — the leading `.global`'s name when the section has one,
// the `.text.<symbol>` suffix otherwise, which must then be a label the
// section defines — is named by the lowered program itself, by an `.init`
// section, or by another surviving section. So a program that never
// imports @8bitscript/c64/raster carries the 1-byte rti and the vector
// stub that points at it, and nothing of the handler
// (packages/c64/AGENTS.md's own measured claim). Anything else — an
// unknown section shape, a `.global` that names no label of its
// section's, a `.text.<symbol>` that neither defines its suffix nor
// exports through a `.global`, a label one section defines twice or two
// sections both define, a symbol a kept section names that no kept
// section defines — is refused BY NAME with the file's path, exactly as
// chr-nes.ts refuses what it does not read: native assembly this silently
// dropped or half-linked would not fail, it would hang a machine with no
// debugger.
//
// What is deliberately NOT handled here: a symbol an `asm6502` block
// names that no section (transitively) defines — that may be one of the
// lowered program's own labels, so it surfaces as the assembler's
// "undefined label" once link() runs over the combined program. A kept
// SECTION's dangling reference, by contrast, is refused here by name:
// native sources resolve against native sources alone.
import { readFileSync } from 'node:fs';

import { parseAsm } from './asm/parse.ts';
import { instructionBytes } from './asm/encode.ts';
import type { Directive } from './asm/assemble.ts';
import type { NativeSource } from './chr-nes.ts';

export interface NativePrograms {
  /** Every `.init.N` section's directives, ascending by N — spliced ahead of the entry function's own body. */
  initProgram: Directive[];
  /** Every surviving `.text.<symbol>` section's directives — spliced beside the backend's other appended routines. */
  textProgram: Directive[];
  /** One size-report row per kept section, so mos/index.ts's "every entry sums to the real bytes" contract holds. */
  entries: { name: string; bytes: number }[];
}

export type NativeResult = ({ ok: true } & NativePrograms) | { ok: false; error: string };

/** A `Directive[]`'s own byte length — the same arithmetic mos/index.ts's size report uses. */
function directiveBytes(program: Directive[]): number {
  let total = 0;
  for (const d of program) {
    if (d.kind === 'label' || d.kind === 'equate') continue;
    if (d.kind === 'byte') { total += d.values.length; continue; }
    total += instructionBytes(d.mode);
  }
  return total;
}

/**
 * Every label name `program` references as an operand — the seed of the
 * mark-and-sweep: a `.text.<symbol>` whose symbol nothing here (or in a
 * kept section) names is dropped. Local-label references were already
 * resolved to their uniquified names by parseAsm, so they collect
 * harmlessly (nothing outside their own block defines them).
 */
export function referencedLabels(program: Directive[]): Set<string> {
  const out = new Set<string>();
  for (const d of program) {
    if (d.kind === 'instruction' && d.operand?.kind === 'label') out.add(d.operand.name);
  }
  return out;
}

/** One `.section`'s worth of a native source, parsed and measured. */
interface Section {
  path: string;
  name: string;
  directives: Directive[];
  /** The leading `.global`'s name, when the section declared one — its public symbol, preferred over the section-name suffix. */
  globalName: string | null;
  /** Labels the section's own body defines. */
  defines: Set<string>;
  /** Label names the section's own body references as operands. */
  references: Set<string>;
}

const SECTION_LINE = /^\.section\s+([^\s,]+)\s*,\s*"ax"\s*,\s*@progbits$/;
const GLOBAL_LINE = /^\.global\s+([A-Za-z_][A-Za-z0-9_]*)$/;
const INIT_SECTION = /^\.init\.([0-9]+)$/;
const TEXT_SECTION = /^\.text\.(.+)$/;

/** The comment-stripped, trimmed reading of a line — parse.ts's own two comment spellings. */
function bare(line: string): string {
  const comment = Math.min(
    ...[line.indexOf(';'), line.indexOf('//')].filter((n) => n >= 0).concat([line.length]),
  );
  return line.slice(0, comment).trim();
}

/** Splits one source into its sections, each body parsed by parseAsm under its own blockId. */
function readSections(source: NativeSource, fileIndex: number): { ok: true; sections: Section[] } | { ok: false; error: string } {
  const sections: Section[] = [];
  let current: { name: string; globalName: string | null; lines: string[]; sawBody: boolean } | null = null;

  const finish = (): { ok: true } | { ok: false; error: string } => {
    if (!current) return { ok: true };
    const parsed = parseAsm(current.lines.join('\n'), `native_${fileIndex}_${sections.length}`);
    if (!parsed.ok) {
      return { ok: false, error: `'${source.path}', section '${current.name}': ${parsed.error}` };
    }
    const defines = new Set<string>();
    for (const d of parsed.directives) {
      if (d.kind !== 'label') continue;
      if (defines.has(d.name)) {
        return { ok: false, error: `'${source.path}': section '${current.name}' defines '${d.name}' twice` };
      }
      defines.add(d.name);
    }
    if (current.globalName !== null && !defines.has(current.globalName)) {
      return {
        ok: false,
        error: `'${source.path}': section '${current.name}' declares '.global ${current.globalName}' but never defines that label`,
      };
    }
    sections.push({
      path: source.path,
      name: current.name,
      directives: parsed.directives,
      globalName: current.globalName,
      defines,
      references: referencedLabels(parsed.directives),
    });
    return { ok: true };
  };

  for (const raw of source.text.split('\n')) {
    const line = bare(raw);
    if (line === '') continue;
    const section = SECTION_LINE.exec(line);
    if (section) {
      const done = finish();
      if (!done.ok) return done;
      current = { name: section[1], globalName: null, lines: [], sawBody: false };
      continue;
    }
    if (line.startsWith('.section')) {
      return {
        ok: false,
        error: `'${source.path}': '${line}' is not a section directive this native reader understands (only .section NAME,"ax",@progbits)`,
      };
    }
    const global = GLOBAL_LINE.exec(line);
    if (global || line.startsWith('.global')) {
      if (!global || !current || current.sawBody || current.globalName !== null) {
        return {
          ok: false,
          error: `'${source.path}': '${line}' — a .global must be the one leading line of a section, naming the label it defines`,
        };
      }
      current.globalName = global[1];
      continue;
    }
    if (!current) {
      return { ok: false, error: `'${source.path}': '${line}' sits outside any section — a native source is .section-delimited` };
    }
    current.sawBody = true;
    current.lines.push(line);
  }
  const done = finish();
  if (!done.ok) return done;
  return { ok: true, sections };
}

/**
 * The `.init`/`.text` programs `sources` contribute to one linked build.
 * `referenced` is every label the already-lowered program names — the
 * mark-and-sweep's seed (referencedLabels over the lowered functions'
 * directives). Split from nativePrograms below so tests feed text
 * directly, the same shape chr-nes.ts's assembleChrRom takes.
 */
export function assembleNative(sources: NativeSource[], referenced: ReadonlySet<string>): NativeResult {
  const inits: { order: number; section: Section }[] = [];
  const texts: { symbol: string; section: Section }[] = [];
  /** Every label any section defines, for the duplicate refusal: two sections cannot own one name. */
  const owners = new Map<string, string>();

  for (let i = 0; i < sources.length; i += 1) {
    const read = readSections(sources[i], i);
    if (!read.ok) return read;
    for (const section of read.sections) {
      for (const label of section.defines) {
        const owner = owners.get(label);
        if (owner !== undefined) {
          return {
            ok: false,
            error: `'${section.path}': section '${section.name}' defines '${label}', which '${owner}' already defines`,
          };
        }
        owners.set(label, `${section.path}' section '${section.name}`);
      }
      const init = INIT_SECTION.exec(section.name);
      if (init) {
        inits.push({ order: Number.parseInt(init[1], 10), section });
        continue;
      }
      const text = TEXT_SECTION.exec(section.name);
      if (text) {
        // The section's public symbol — what the mark-and-sweep keys on —
        // is what it actually exports: its leading .global when it has
        // one (readSections proved that names a label of its own), the
        // .text.<symbol> suffix otherwise, which must then be a label the
        // section defines. A suffix that names nothing here would make
        // the section unreachable under its own name — refused, not kept.
        if (section.globalName === null && !section.defines.has(text[1])) {
          return {
            ok: false,
            error: `'${section.path}': section '${section.name}' never defines '${text[1]}' — a .text.<symbol> section must define its symbol, or name the label it exports with a leading .global`,
          };
        }
        texts.push({ symbol: section.globalName ?? text[1], section });
        continue;
      }
      return {
        ok: false,
        error: `'${section.path}' has a section '${section.name}' this native reader does not understand: only .init.N and .text.<symbol> are read`,
      };
    }
  }

  // Ascending N across every source; Array.prototype.sort is stable, so
  // equal Ns keep their source order.
  inits.sort((a, b) => a.order - b.order);

  // Mark-and-sweep. The kept set starts from what the lowered program
  // itself names plus what every .init section (always kept) names, then
  // grows through the kept sections' own references to a fixed point.
  const reachable = new Set(referenced);
  for (const { section } of inits) for (const name of section.references) reachable.add(name);
  const kept = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const { symbol, section } of texts) {
      if (kept.has(symbol) || !reachable.has(symbol)) continue;
      kept.add(symbol);
      for (const name of section.references) reachable.add(name);
      grew = true;
    }
  }

  const keptTexts = texts.filter(({ symbol }) => kept.has(symbol));

  // Native sources resolve against native sources alone: every label a
  // kept section names must be one a kept section defines. Refused here
  // by symbol and by file, rather than left for assembleRelaxed()'s
  // generic 'undefined label' once link() runs over the combined program.
  const keptSections = [...inits.map(({ section }) => section), ...keptTexts.map(({ section }) => section)];
  const provided = new Set<string>();
  for (const section of keptSections) for (const label of section.defines) provided.add(label);
  for (const section of keptSections) {
    for (const name of section.references) {
      if (!provided.has(name)) {
        return {
          ok: false,
          error: `'${section.path}': section '${section.name}' references '${name}', which no kept native section defines`,
        };
      }
    }
  }

  const entryOf = (section: Section) => ({ name: `(native ${section.name})`, bytes: directiveBytes(section.directives) });
  return {
    ok: true,
    initProgram: inits.flatMap(({ section }) => section.directives),
    textProgram: keptTexts.flatMap(({ section }) => section.directives),
    entries: [...inits.map(({ section }) => entryOf(section)), ...keptTexts.map(({ section }) => entryOf(section))],
  };
}

/**
 * assembleNative over files on disk. Synchronous for the same reason
 * image-nes.ts's readSources is: a handful of small files the resolver
 * already proved exist, read once per build.
 */
export function nativePrograms(paths: string[], referenced: ReadonlySet<string>): NativeResult {
  return assembleNative(paths.map((path) => ({ path, text: readFileSync(path, 'utf8') })), referenced);
}
