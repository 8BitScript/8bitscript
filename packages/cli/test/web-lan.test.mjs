import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';

import {
  createLanCertificate,
  DEFAULT_WEB_PORT,
  defaultOpensslPath,
  isLoopbackAddress,
  lanIPv4,
  listenWebDev,
  parseListenPort,
  serveBanner,
} from '../src/web-lan.mjs';

test('lanIPv4 skips loopback, VPN/radio ifaces, link-local, and IPv6, and prefers 192.168', () => {
  assert.deepEqual(
    lanIPv4({
      lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      en0: [
        { family: 'IPv4', address: '10.0.0.4', internal: false },
        { family: 'IPv4', address: '192.168.1.20', internal: false },
        { family: 'IPv4', address: '169.254.9.1', internal: false },
        { family: 'IPv6', address: 'fe80::1', internal: false },
      ],
      utun0: [{ family: 'IPv4', address: '10.8.0.2', internal: false }],
      awdl0: [{ family: 'IPv4', address: '192.168.99.1', internal: false }],
    }),
    ['192.168.1.20', '10.0.0.4'],
  );
});

test('isLoopbackAddress names IPv4, IPv6, and IPv4-mapped loopback', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.20'), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('isLoopbackAddress takes the whole of 127.0.0.0/8, mapped or not', () => {
  assert.equal(isLoopbackAddress('127.0.0.2'), true);
  assert.equal(isLoopbackAddress('127.1.2.3'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.5'), true);
  // The mapped form of a LAN peer is still a LAN peer.
  assert.equal(isLoopbackAddress('::ffff:192.168.1.20'), false);
});

test('defaultOpensslPath picks an absolute path, present or not', () => {
  assert.equal(
    defaultOpensslPath(['/no/such/openssl', '/usr/bin/openssl']),
    '/usr/bin/openssl',
    'the first candidate that exists wins',
  );
  // Nothing installed still yields an absolute path: spawnSync reports
  // ENOENT on it and the caller falls back to HTTP with a warning.
  assert.equal(defaultOpensslPath(['/no/such/openssl', '/also/missing']), '/also/missing');
  assert.ok(defaultOpensslPath().startsWith('/'), 'never a bare name resolved through PATH');
});

test('parseListenPort defaults to 8008, accepts 0, and refuses junk', () => {
  assert.equal(DEFAULT_WEB_PORT, 8008);
  assert.deepEqual(parseListenPort(undefined), { ok: true, port: 8008 });
  assert.deepEqual(parseListenPort('0'), { ok: true, port: 0 });
  assert.deepEqual(parseListenPort('8008'), { ok: true, port: 8008 });
  assert.equal(parseListenPort('nope').ok, false);
  assert.equal(parseListenPort('99999').ok, false);
});

test('serveBanner prints the loopback URL, and LAN lines only when there are some', () => {
  const local = serveBanner({ local: 'http://127.0.0.1:9/' });
  assert.match(local, /^serving http:\/\/127\.0\.0\.1:9\/\n/);
  assert.match(local, /Simple Browser/);
  assert.doesNotMatch(local, /on your LAN/);

  const lan = serveBanner({
    local: 'http://127.0.0.1:9/',
    lan: true,
    lanUrls: ['http://192.168.1.20:9/', 'https://192.168.1.20:10/'],
  });
  assert.match(lan, /on your LAN: http:\/\/192\.168\.1\.20:9\//);
  assert.match(lan, /on your LAN: https:\/\/192\.168\.1\.20:10\//);
  assert.match(lan, /Open the http:\/\/ line/);

  const none = serveBanner({ local: 'http://127.0.0.1:9/', lan: true, lanUrls: [] });
  assert.match(none, /listening on 0\.0\.0\.0/);
});

test('createLanCertificate reports a missing openssl rather than throwing', () => {
  const result = createLanCertificate({
    addresses: ['192.168.1.20'],
    dir: join(tmpdir(), '8bs-lan-missing-openssl'),
    openssl: '/no/such/openssl',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /openssl was not found/);
});

test('listenWebDev without --lan serves only loopback HTTP', async () => {
  const listening = await listenWebDev((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  try {
    const response = await fetch(listening.local);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
    assert.deepEqual(listening.lanUrls, []);
  } finally {
    await listening.close();
  }
});

test('listenWebDev honors a requested port, and names it when that port is taken', async () => {
  const port = 18008;
  const first = await listenWebDev((req, res) => {
    res.writeHead(200);
    res.end('a');
  }, { port });
  try {
    assert.equal(first.error, undefined);
    assert.equal(first.local, `http://127.0.0.1:${port}/`);
    assert.equal(await (await fetch(first.local)).text(), 'a');
    const second = await listenWebDev((req, res) => {
      res.writeHead(200);
      res.end('b');
    }, { port });
    assert.match(second.error ?? '', /already in use/);
    await second.close();
  } finally {
    await first.close();
  }
});

test('listenWebDev --lan binds HTTP on the LAN even when openssl is missing', async () => {
  const listening = await listenWebDev(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    },
    { lan: true, openssl: '/no/such/openssl', certDir: join(tmpdir(), '8bs-lan-no-openssl') },
  );
  try {
    assert.equal(await (await fetch(listening.local)).text(), 'ok');
    const httpLan = listening.lanUrls.filter((url) => url.startsWith('http://'));
    const httpsLan = listening.lanUrls.filter((url) => url.startsWith('https://'));
    assert.equal(httpsLan.length, 0);
    if (httpLan.length > 0) {
      assert.equal(await (await fetch(httpLan[0])).text(), 'ok');
    }
    if (listening.lanWarning) assert.match(listening.lanWarning, /openssl was not found/);
  } finally {
    await listening.close();
  }
});

test('createLanCertificate and listenWebDev --lan serve HTTPS on a LAN address', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), '8bs-lan-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const addresses = lanIPv4();
  const tls = createLanCertificate({ addresses: addresses.length ? addresses : ['10.0.0.1'], dir });
  if (!tls.ok) {
    t.skip(tls.error);
    return;
  }
  assert.ok(tls.cert.includes('BEGIN CERTIFICATE'));
  assert.ok(tls.key.includes('BEGIN PRIVATE KEY') || tls.key.includes('BEGIN RSA PRIVATE KEY'));

  const again = createLanCertificate({ addresses: addresses.length ? addresses : ['10.0.0.1'], dir });
  assert.equal(again.ok, true, 'a matching SAN list reuses the cert rather than calling openssl again');

  if (addresses.length === 0) {
    t.skip('no LAN IPv4 on this machine');
    return;
  }

  const listening = await listenWebDev(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('lan');
    },
    { lan: true, certDir: dir },
  );
  try {
    assert.equal((await fetch(listening.local)).status, 200);
    const httpsUrls = listening.lanUrls.filter((url) => url.startsWith('https://'));
    const httpUrls = listening.lanUrls.filter((url) => url.startsWith('http://'));
    assert.ok(httpsUrls.length > 0, 'HTTPS URLs for each LAN IPv4');
    assert.equal(await httpsGet(httpsUrls[0]), 'lan');
    if (httpUrls.length > 0) {
      const redirected = await fetch(httpUrls[0], { redirect: 'manual' });
      assert.equal(redirected.status, 302);
      assert.match(redirected.headers.get('location') ?? '', /^https:\/\//);
    }
  } finally {
    await listening.close();
  }
});

/** fetch() refuses a self-signed cert; the phone taps through, tests do this. */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    httpsRequest(url, { rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    }).on('error', reject).end();
  });
}
