import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'marketplace-publish-loop.sh');

function stub(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

// Fake az, curl, node and sleep. State lives in files under `dir`:
//   az-tokens   one line per `az account get-access-token`, in order
//   az-fail     if present, `az account get-access-token` fails
//   node-fail   number of leading `node` calls that fail
function run({ env = {}, tokens = ['tok-first-AAA', 'tok-second-BBB', 'tok-third-CCC'], azFail = false, raw = false, nodeFail = 0, curlEmpty = false, loginFail = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'mkt-loop-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(dir, 'az-tokens'), tokens.join('\n') + '\n');
    if (azFail) writeFileSync(join(dir, 'az-fail'), '');
    if (raw) writeFileSync(join(dir, 'az-raw'), '');
    if (loginFail) writeFileSync(join(dir, 'az-login-fail'), '');
    writeFileSync(join(dir, 'node-fail'), String(nodeFail));
    stub(bin, 'az', `
if [ "$1 $2" = "account get-access-token" ]; then
  echo "get-access-token" >> "${dir}/az.log"
  [ -e "${dir}/az-fail" ] && exit 1
  echo x >> "${dir}/az-gets"
  n=$(wc -l < "${dir}/az-gets" | tr -d ' ')
  [ -e "${dir}/az-raw" ] && { cat "${dir}/az-tokens"; exit 0; }
  sed -n "$((n > 3 ? 3 : n))p" "${dir}/az-tokens"
elif [ "$1" = login ]; then
  echo "login $*" >> "${dir}/az.log"
  [ -e "${dir}/az-login-fail" ] && exit 1
  exit 0
else
  exit 2
fi`);
    stub(bin, 'curl', `
echo "curl $*" >> "${dir}/curl.log"
${curlEmpty ? 'exit 0' : `echo '{"value":"jwt-secret-ZZZ"}'`}`);
    stub(bin, 'sleep', 'exit 0');
    stub(bin, 'node', `
echo "node aad=\${VSCE_AAD_TOKEN:-} pat=\${VSCE_PAT:-}" >> "${dir}/node.log"
calls=$(wc -l < "${dir}/node.log" | tr -d ' ')
[ "$calls" -le "$(cat "${dir}/node-fail")" ] && exit 1
exit 0`);
    const result = spawnSync('bash', [SCRIPT, '/tmp/x.vsix'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        AZURE_CLIENT_ID: 'client',
        AZURE_TENANT_ID: 'tenant',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/?a=b',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token',
        RETRY_DELAY: '0',
        ...env,
      },
    });
    const read = (name) => {
      try {
        return readFileSync(join(dir, name), 'utf8');
      } catch {
        return '';
      }
    };
    const output = result.stdout + result.stderr;
    // Everything the runner would show: add-mask lines are consumed by it.
    const visible = output
      .split('\n')
      .filter((line) => !line.startsWith('::add-mask::'))
      .join('\n');
    return { status: result.status, output, visible, azLog: read('az.log'), curlLog: read('curl.log'), nodeLog: read('node.log') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('attempt 1 publishes with the token from the sign-in', () => {
  const r = run({ env: { AZURE_LOGIN_OUTCOME: 'success' } });
  assert.equal(r.status, 0);
  assert.equal(r.nodeLog, 'node aad=tok-first-AAA pat=\n');
  assert.doesNotMatch(r.azLog, /login/);
  assert.match(r.output, /^::add-mask::tok-first-AAA$/m);
});

test('a later attempt signs in again and uses the new token', () => {
  const r = run({ env: { AZURE_LOGIN_OUTCOME: 'success' }, nodeFail: 1 });
  assert.equal(r.status, 0);
  assert.equal(r.nodeLog, 'node aad=tok-first-AAA pat=\nnode aad=tok-second-BBB pat=\n');
  assert.match(r.azLog, /login --service-principal -u client --tenant tenant --federated-token jwt-secret-ZZZ/);
  assert.match(r.output, /^::add-mask::jwt-secret-ZZZ$/m);
  assert.match(r.output, /^::add-mask::tok-second-BBB$/m);
  assert.match(r.curlLog, /audience=api:\/\/AzureADTokenExchange/);
  assert.match(r.curlLog, /Authorization: bearer request-token/);
});

for (const [name, opts] of [
  ['the OIDC request returns nothing', { curlEmpty: true }],
  ['az login exits non-zero', { loginFail: true }],
]) {
  test(`when ${name} on attempt 2, the PAT is used and no stale token is read`, () => {
    const r = run({
      env: { AZURE_LOGIN_OUTCOME: 'success', VSCE_PAT: 'pat-value' },
      nodeFail: 1,
      ...opts,
    });
    assert.equal(r.status, 0);
    assert.equal(r.nodeLog, 'node aad=tok-first-AAA pat=pat-value\nnode aad= pat=pat-value\n');
    // Only attempt 1 read an access token; the failed login stopped attempt 2 from asking az.
    assert.equal(r.azLog.split('\n').filter((l) => l === 'get-access-token').length, 1);
    assert.match(r.output, /Azure sign-in again failed on attempt 2/);
    assert.ok(!r.visible.includes('tok-first-AAA') && !r.visible.includes('tok-second-BBB'));
  });
}

test('the PAT is used when az cannot give a token', () => {
  const r = run({ env: { AZURE_LOGIN_OUTCOME: 'success', VSCE_PAT: 'pat-value' }, azFail: true });
  assert.equal(r.status, 0);
  assert.equal(r.nodeLog, 'node aad= pat=pat-value\n');
  assert.match(r.output, /using VSCE_PAT for this attempt/);
});

test('a multi-line token is rejected and the PAT is used', () => {
  const r = run({
    env: { AZURE_LOGIN_OUTCOME: 'success', VSCE_PAT: 'pat-value' },
    tokens: ['line-one-LEAK', 'line-two'],
    raw: true,
  });
  assert.equal(r.status, 0);
  assert.equal(r.nodeLog, 'node aad= pat=pat-value\n');
  assert.ok(!r.visible.includes('line-one-LEAK'), 'rejected token leaked');
});

test('with az get-access-token failing and no PAT, every attempt fails and the loop exits 1', () => {
  const r = run({ env: { AZURE_LOGIN_OUTCOME: 'success' }, azFail: true });
  assert.equal(r.status, 1);
  assert.equal(r.nodeLog, '');
});

test('no token or JWT value appears outside an add-mask line', () => {
  const r = run({ env: { AZURE_LOGIN_OUTCOME: 'success', VSCE_PAT: 'pat-value' }, nodeFail: 2 });
  assert.equal(r.status, 0);
  for (const secret of ['tok-first-AAA', 'tok-second-BBB', 'tok-third-CCC', 'jwt-secret-ZZZ']) {
    assert.ok(!r.visible.includes(secret), `${secret} leaked`);
  }
});
