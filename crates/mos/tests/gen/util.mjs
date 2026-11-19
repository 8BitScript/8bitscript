// Shared helpers for the PR-A gen scripts: JSON encoding of results and a writer.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const label = (name, extra = {}) => ({ kind: 'label', name, ...extra });
export const equate = (name, value) => ({ kind: 'equate', name, value });
export const bytes = (...values) => ({ kind: 'byte', values });
export const ins = (mnemonic, mode, operand) => ({
  kind: 'instruction', mnemonic, mode, ...(operand ? { operand } : {}),
});
export const val = (value) => ({ kind: 'value', value });
export const lab = (name, extra = {}) => ({ kind: 'label', name, ...extra });

/** AssembleResult to JSON: Uint8Array as numbers, Map as pairs, no `prov`. */
export function encodeAssembled(r) {
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    bytes: [...r.bytes],
    listing: r.listing.map(({ prov, ...rest }) => rest),
    labels: [...r.labels],
  };
}

export function write(name, rows) {
  const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${name}.json`, `${JSON.stringify(rows)}\n`);
  console.log(`${name}: ${rows.length} rows`);
}
