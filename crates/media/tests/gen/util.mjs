// Shared by the media gen scripts: a fixture writer.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function write(name, rows) {
  const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${name}.json`, `${JSON.stringify(rows)}\n`);
  console.log(`${name}: ${rows.length} rows`);
}
