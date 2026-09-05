// Hardware hazards: writes a target documents as able to damage the machine.
//
// The root AGENTS.md warns against turning one game's trivia into a compiler
// diagnostic. This table is the deliberate exception, and its bar is high: a
// write goes here only when the target's own documentation says it can
// destroy hardware — not crash the program, not garble the screen, destroy
// hardware. There is one entry today. The PET's "killer poke" (POKE 59458,62
// — `$E842`, the 6522 VIA's data-direction register B) makes port bit PB5
// an output. PB5 is the vertical-retrace *input*; on the CRTC models (the
// 12-inch 4032, 8032 and later) it is wired to the CRTC's vertical sync,
// which also drives the monitor, and driving that line drags its level down
// until the monitor's vertical deflection misbehaves and, in time, the
// flyback fails. See packages/pet/AGENTS.md ("Hazards").
//
// The rule is narrow on purpose: the register has legitimate uses (its
// other bits steer the cassette motor and IEEE-488 lines), so a write whose
// value 8bitscript can see at compile time — a literal or a const — with bit
// 5 clear is allowed, and only a write it cannot prove safe is refused: a
// constant with bit 5 set, or a runtime value. Reads are always fine.
//
// The check runs in the linker, not the checker, because it needs two
// things only the linker has: the machine being built for, and every const
// already inlined (so `memory.write(VIA_DDRB, 62)` with `VIA_DDRB` imported
// from another module is the same write as the literal). `8bs check` and the
// editor analyse files without a machine, so this class of diagnostic is a
// build-time one; docs/compiler.md and docs/language-server.md say so.

import { Codes, diagnostic } from '../diagnostics/index.mjs';

/**
 * Per machine: the addresses whose writes are checked. `forbiddenBits` is
 * the mask a compile-time value must have clear to be allowed; `name` and
 * `why` are the words of the message.
 */
export const HARDWARE_HAZARDS = {
  pet: [
    {
      address: 0xE842,
      forbiddenBits: 0x20,
      name: 'the VIA\'s data-direction register B ($E842, POKE 59458)',
      why: 'a value with bit 5 set makes PB5 an output — the PET "killer poke", which drives the monitor\'s '
        + 'vertical sync on the CRTC models (4032, 8032 and later) and can destroy a 12-inch PET display. '
        + 'Only a compile-time value with bit 5 clear may be written here; see packages/pet/AGENTS.md',
    },
  ],
};

const hex = (n) => `$${n.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Walk the linked program's functions for writes to a hazardous address on
 * `machine`, reporting each as `8BS3003` in the file it was written in.
 *
 * Three ways to write an address are covered: `memory.write(address, v)`
 * with a compile-time address; assignment to a scalar global declared
 * `@address(...)` there; and an element store into an `@address` array that
 * covers it (a compile-time index that lands on it, or a runtime index,
 * which cannot be proved to miss). Everything else — a runtime address to
 * `memory.write`, say — is the program's own responsibility, as on the
 * machine.
 *
 * @param {object} ir            the linked IR (globals carry output names and addresses)
 * @param {string|undefined} machine
 * @param {Map<object, string>} fileOf  each function to the file it came from
 * @param {object[]} diagnostics
 */
export function checkHardwareHazards(ir, machine, fileOf, diagnostics) {
  const hazards = machine ? HARDWARE_HAZARDS[machine] : undefined;
  if (!hazards) return;

  // The globals that map a hazardous address, by output name: scalars at
  // it exactly, arrays that span it (with the element offset that is it).
  const scalars = new Map();
  const arrays = new Map();
  for (const g of ir.globals) {
    if (g.address === null || g.address === undefined) continue;
    for (const hazard of hazards) {
      if (!g.array && g.address === hazard.address) scalars.set(g.name, hazard);
      if (g.array && g.address <= hazard.address && hazard.address < g.address + g.array) {
        arrays.set(g.name, { hazard, offset: hazard.address - g.address });
      }
    }
  }

  const safe = (value, hazard) => value?.kind === 'const' && (value.value & hazard.forbiddenBits) === 0;
  const report = (node, file, hazard, how) => diagnostics.push(diagnostic(
    Codes.HARDWARE_HAZARD,
    `${how} ${hazard.name} on the ${machine}: ${hazard.why}`,
    file, node.start ?? 0, node.length ?? 0,
  ));
  const describe = (value) => (value?.kind === 'const' ? `writing ${value.value} to` : 'writing a runtime value to');

  const visit = (s, file) => {
    if (s.kind === 'memoryWrite' && s.address?.kind === 'const') {
      const hazard = hazards.find((h) => h.address === s.address.value);
      if (hazard && !safe(s.value, hazard)) report(s, file, hazard, describe(s.value));
    } else if (s.kind === 'assign' && scalars.has(s.target)) {
      const hazard = scalars.get(s.target);
      if (!safe(s.value, hazard)) report(s, file, hazard, describe(s.value));
    } else if (s.kind === 'storeIndex' && arrays.has(s.array?.name)) {
      const { hazard, offset } = arrays.get(s.array.name);
      const index = s.index;
      if (index?.kind === 'const' && index.value !== offset) return;
      if (!safe(s.value, hazard)) {
        const how = index?.kind === 'const'
          ? describe(s.value)
          : `an element store with a runtime index cannot be proved to miss ${hex(hazard.address)}, so this counts as writing to`;
        report(s, file, hazard, how);
      }
    }
  };
  const walk = (body, file) => {
    for (const s of body) {
      visit(s, file);
      if (s.kind === 'if') { walk(s.then, file); if (s.else) walk(s.else, file); }
      else if (s.kind === 'while' || s.kind === 'block') walk(s.body, file);
      else if (s.kind === 'for') { if (s.init) visit(s.init, file); if (s.update) visit(s.update, file); walk(s.body, file); }
    }
  };
  for (const fn of ir.functions) walk(fn.body, fileOf.get(fn) ?? '');
}
