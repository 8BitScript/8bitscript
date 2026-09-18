// The two debug/development artifacts this backend can produce from data
// it already has once a build carries provenance (provenance.ts) all the
// way to the assembler's own listing: a human-readable `.lst` and a
// versioned, machine-readable `.8bs.debug.json`. Neither is a disassembler
// — every field here comes straight off ListingLine (asm/assemble.ts),
// which the assembler already produces for every build; this module only
// shapes and serializes it.
import { positionAt } from '../diagnostics/index.mjs';
import type { ListingLine } from './asm/assemble.ts';

export interface DebugSymbol {
  name: string;
  kind: 'function' | 'global';
  address: number;
  type?: string;
}

/** One instruction (or `.byte` run) in the debug map — ListingLine plus line/column (resolved against `sources`, when the file's text is known) and the container-relative offset a debugger reading a file on disk needs alongside the CPU address a running emulator reports. */
export interface DebugInstruction {
  address: number;
  // Offset into BuildResult.bytes — the linked code+data image this
  // backend produces, before any further container wrapping (a Commodore
  // .prg's 2-byte load address, an Atari .xex's segment headers, an NES
  // .nes's iNES header) a target's own image step (image.ts, image-nes.ts,
  // image-atari8.ts) may add after build() returns. Not the same number as
  // `address` in general — see the plan this schema was built from
  // ("Runtime Address vs File Offset") — and left out of this comment's
  // promise for a target whose container isn't a fixed-size prefix, so a
  // consumer never has to guess which meaning it got.
  artifactOffset: number;
  size: number;
  bytes: number[];
  assembly: string;
  source: { file: string; start: number; length: number; line: number; column: number; text?: string } | null;
  function: string | null;
  origin: string | null;
  component: string | null;
  generated?: { reason: string };
}

export interface DebugMap {
  format: '8bitscript-debug';
  version: 1;
  target: string;
  modules: string[];
  symbols: DebugSymbol[];
  instructions: DebugInstruction[];
}

/** The line of source text an instruction's span starts on, trimmed — `.lst`/hover text, never a correctness-bearing field (a multi-line span only ever shows its first line). Absent instead of guessed when the file's text isn't in `sources`. */
function sourceLine(text: string, start: number): string {
  const from = text.lastIndexOf('\n', start) + 1;
  let to = text.indexOf('\n', start);
  if (to === -1) to = text.length;
  return text.slice(from, to).trim();
}

/**
 * Turns the linked program's listing into the versioned debug map. `codeOrigin`
 * is where `listing`'s addresses start (mos/index.ts's own combinedProgram
 * origin) — `artifactOffset` is address-relative to it, plus `dataOrigin`'s
 * own running offset for the code section's own byte length, exactly the
 * way link()/place() lays code then data with no gap.
 */
export function buildDebugMap(
  listing: ListingLine[],
  symbols: DebugSymbol[],
  target: string,
  codeOrigin: number,
  sources: Map<string, string>,
): DebugMap {
  const modules = new Set<string>();
  const instructions: DebugInstruction[] = listing.map((line) => {
    const prov = line.prov;
    const src = prov?.source ?? null;
    let source: DebugInstruction['source'] = null;
    if (src) {
      modules.add(src.file);
      const text = sources.get(src.file);
      const position = text ? positionAt(text, src.start) : { line: 0, column: 0 };
      source = {
        file: src.file, start: src.start, length: src.length,
        line: position.line, column: position.column,
        ...(text ? { text: sourceLine(text, src.start) } : {}),
      };
    }
    return {
      address: line.address,
      artifactOffset: line.address - codeOrigin,
      size: line.bytes.length,
      bytes: line.bytes,
      assembly: line.text,
      source,
      function: prov?.function ?? null,
      origin: prov?.origin ?? null,
      component: prov?.component ?? null,
      ...(prov?.generated ? { generated: prov.generated } : {}),
    };
  });
  return {
    format: '8bitscript-debug',
    version: 1,
    target,
    modules: [...modules].sort(),
    symbols,
    instructions,
  };
}

/** One `.lst` section header's worth of context — a run of consecutive listing lines that share it groups under one header instead of repeating it per line. */
interface Group {
  file: string | null;
  function: string | null;
  component: string | null;
  origin: string | null;
}

function groupOf(line: ListingLine): Group {
  const prov = line.prov;
  return {
    file: prov?.source?.file ?? null,
    function: prov?.function ?? null,
    component: prov?.component ?? null,
    origin: prov?.origin ?? null,
  };
}

function sameGroup(a: Group, b: Group): boolean {
  return a.file === b.file && a.function === b.function && a.component === b.component && a.origin === b.origin;
}

function hex(value: number, digits = 4): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

/** The human-readable listing — an official compiler artifact, not a debug dump: grouped by module/function/component so a reader sees where one ends and the next begins, source text shown once per line it actually changes, address/bytes/assembly columns aligned. */
export function renderListing(listing: ListingLine[], target: string, sources: Map<string, string>): string {
  const out: string[] = [`; 8bitscript generated assembly listing — target: ${target}`, ''];
  let group: Group | null = null;
  let line: number | null = null;
  for (const entry of listing) {
    const nextGroup = groupOf(entry);
    if (!group || !sameGroup(group, nextGroup)) {
      if (group) out.push('');
      out.push('; ' + '='.repeat(66));
      if (nextGroup.file) out.push(`; ${nextGroup.file}`);
      if (nextGroup.component) out.push(`; component: ${nextGroup.component}`);
      if (nextGroup.function) out.push(`; function: ${nextGroup.function}`);
      if (nextGroup.origin) out.push(`; origin (inlined from): ${nextGroup.origin}`);
      if (!nextGroup.file && !nextGroup.function) out.push('; (compiler-generated — no direct source)');
      out.push('; ' + '='.repeat(66), '');
      group = nextGroup;
      line = null;
    }
    const src = entry.prov?.source;
    if (src) {
      const text = sources.get(src.file);
      const position = text ? positionAt(text, src.start) : null;
      if (position && position.line !== line) {
        line = position.line;
        out.push(`; line ${position.line}`);
        if (text) out.push(`; ${sourceLine(text, src.start)}`);
        out.push('');
      }
    }
    const bytes = entry.bytes.map((b) => hex(b, 2)).join(' ').padEnd(9);
    const reason = entry.prov?.generated ? `  ; (compiler-generated: ${entry.prov.generated.reason})` : '';
    out.push(`$${hex(entry.address)}   ${bytes}   ${entry.text}${reason}`);
  }
  out.push('');
  return out.join('\n');
}
