import assert from 'node:assert/strict';
import test from 'node:test';

import { link } from '../index.mjs';

test('elaboration inlines a stateless component body', async () => {
  const main = `import { text } from "@8bitscript/text";
component Hello() { text.print(0, "X"); }
export function main(): void { <Hello />; }
`;
  const result = await link(main, 'main.8bx', { machine: 'pet', frameRate: 60, facts: {} });
  assert.equal(result.diagnostics.some((d) => d.code === '8BS3001'), false);
  assert.ok(result.ir);
});
