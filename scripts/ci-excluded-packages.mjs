import { MACHINES } from '../packages/compiler/index.mjs';

/**
 * Workspace package directory names skipped by `pnpm run test:ci` and
 * `pnpm run test:coverage`. Every machine package either boots an emulator
 * or runs `8bs build` against a target; parked machines now refuse that
 * build, and the release machines we still compile are covered by
 * compiler/cli/examples tests instead of per-package probe runs.
 */
export const CI_EXCLUDED_PACKAGE_DIRS = new Set(['pointer', ...MACHINES]);

/** `pnpm --filter` arguments that drop those packages from a recursive run. */
export function ciTestFilters() {
  return [...CI_EXCLUDED_PACKAGE_DIRS].map((dir) => `--filter=!@8bitscript/${dir}`);
}
