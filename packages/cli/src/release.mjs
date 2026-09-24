// Single place the CLI reads which machines this release builds for.
import { MACHINES, RELEASE_MACHINES } from '@8bitscript/compiler';

function listOf(names) {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export { MACHINES, RELEASE_MACHINES };

/** `pet|c64|vic20|cx16|web` for usage lines. */
export function releaseTargetPipe() {
  return RELEASE_MACHINES.join('|');
}

/** Boot has no bare web emulator — every release machine except web. */
export function releaseBootTargetPipe() {
  return RELEASE_MACHINES.filter((m) => m !== 'web').join('|');
}

/** `pet, c64, vic20, cx16, and web` for refusal messages. */
export function releaseTargetList() {
  return listOf(RELEASE_MACHINES);
}

export function parkedCount() {
  return MACHINES.filter((m) => !RELEASE_MACHINES.includes(m)).length;
}

/** Second line under `8bs run` / `8bs build` usage when no target is given. */
export function releaseUsageNote() {
  const n = parkedCount();
  if (n === 0) return '';
  return `                (${n} other machines are parked until later releases; \`8bs targets\` lists them)\n`;
}
