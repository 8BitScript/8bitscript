// LAN reachability for `8bs run web --lan`.
//
// A phone cannot open a server bound to 127.0.0.1: that is the address
// that made the printed port look closed from the LAN. --lan therefore
// binds HTTP on 0.0.0.0 (same port the editor already uses on loopback)
// and, when openssl can mint a cert, HTTPS on 0.0.0.0 as well. SharedArrayBuffer
// is not legal on plain http://192.168.x.x, so a non-loopback HTTP request
// redirects to that HTTPS port. Safari will warn once; after Proceed,
// COOP/COEP make the tab isolated.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';

/** ~/.config/8bitscript/lan-tls — same XDG-shaped home the controller file uses. */
export function defaultCertDir() {
  return join(homedir(), '.config', '8bitscript', 'lan-tls');
}

/** HTTP port `8bs run web` binds unless `--port` says otherwise. 0 is
 *  ephemeral so two runs can listen at once; `--port n` pins HTTP to n
 *  and HTTPS to n+1. */
export const DEFAULT_WEB_PORT = 0;

/**
 * @param {string | undefined} value
 * @param {number} [fallback]
 * @returns {{ ok: true, port: number } | { ok: false, error: string }}
 */
export function parseListenPort(value, fallback = DEFAULT_WEB_PORT) {
  if (value === undefined || value === '') return { ok: true, port: fallback };
  if (!/^\d+$/.test(value)) {
    return { ok: false, error: `--port expects a number, got '${value}'` };
  }
  const port = Number.parseInt(value, 10);
  if (port > 65535) {
    return { ok: false, error: `--port expects 0–65535, got '${value}'` };
  }
  return { ok: true, port };
}

/** VPN / Apple-radio / sharing ifaces: their IPs are not what a phone on Wi-Fi can open. */
const SKIP_IFACE = /^(lo|utun|awdl|llw|bridge|ipsec|ppp|ap\d|anpi|gif|stf|vmnet|vnic)/i;

function lanRank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  const oct = /^172\.(\d+)\./.exec(ip);
  if (oct) {
    const n = Number(oct[1]);
    if (n >= 16 && n <= 31) return 2;
  }
  return 3;
}

/**
 * Non-internal IPv4 addresses, the ones a phone on the same Wi-Fi can type.
 *
 * @param {NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>} [nics]
 * @returns {string[]}
 */
export function lanIPv4(nics = networkInterfaces()) {
  const ips = [];
  for (const [name, addrs] of Object.entries(nics)) {
    if (SKIP_IFACE.test(name)) continue;
    for (const addr of addrs ?? []) {
      // family is the string 'IPv4' — Node briefly returned the number 4
      // in 18.0-18.3 and went back, and this package needs node >= 26.
      const v4 = addr.family === 'IPv4';
      if (!v4 || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;
      ips.push(addr.address);
    }
  }
  return ips.sort((a, b) => lanRank(a) - lanRank(b) || a.localeCompare(b));
}

/**
 * The URL a phone should open: HTTPS first (SharedArrayBuffer is legal
 * there), else the first HTTP LAN line, else null.
 *
 * @param {string[]} [lanUrls]
 * @returns {string | null}
 */
export function preferredLanUrl(lanUrls = []) {
  return lanUrls.find((url) => url.startsWith('https://')) ?? lanUrls[0] ?? null;
}

/** How a dual-stack socket writes an IPv4 peer: ::ffff: then the dotted quad. */
const V4_MAPPED_PREFIX = '::ffff:';

/**
 * @param {string | undefined} remote
 * @returns {boolean}
 */
export function isLoopbackAddress(remote) {
  if (!remote) return false;
  // A dual-stack listener reports an IPv4 peer in the mapped form
  // ::ffff:a.b.c.d, so unwrap that before judging the address. The whole
  // of 127.0.0.0/8 is loopback, not just .1.
  const addr = remote.startsWith(V4_MAPPED_PREFIX) ? remote.slice(V4_MAPPED_PREFIX.length) : remote;
  return addr === '::1' || addr.startsWith('127.');
}

function opensslConfig(subjectAltName) {
  return `[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3
[dn]
CN = 8bitscript-lan
[v3]
subjectAltName = ${subjectAltName}
`;
}

/** Where openssl actually lives, most specific first. */
const OPENSSL_PATHS = ['/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', '/usr/bin/openssl'];

/**
 * openssl as an absolute path rather than a PATH lookup. This cert is what
 * the browser is asked to trust for the session, so which binary mints it
 * should not depend on what sits in front of /usr/bin on this shell's PATH.
 * Nothing installed is not an error here: spawnSync reports ENOENT on the
 * last candidate and the caller falls back to HTTP with a warning.
 *
 * @param {string[]} [paths]
 * @returns {string}
 */
export function defaultOpensslPath(paths = OPENSSL_PATHS) {
  return paths.find((candidate) => existsSync(candidate)) ?? paths[paths.length - 1];
}

/**
 * Mint (or reuse) a self-signed cert covering localhost and the given LAN IPs.
 *
 * @param {{ addresses: string[], dir?: string, openssl?: string }} options
 * @returns {{ ok: true, cert: Buffer, key: Buffer } | { ok: false, error: string }}
 */
export function createLanCertificate({ addresses, dir = defaultCertDir(), openssl = defaultOpensslPath() }) {
  const subjectAltName = ['DNS:localhost', 'IP:127.0.0.1', ...addresses.map((ip) => `IP:${ip}`)].join(',');
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  const sansPath = join(dir, 'sans.txt');
  if (
    existsSync(certPath)
    && existsSync(keyPath)
    && existsSync(sansPath)
    && readFileSync(sansPath, 'utf8') === subjectAltName
  ) {
    return { ok: true, cert: readFileSync(certPath), key: readFileSync(keyPath) };
  }
  const configPath = join(dir, 'openssl.cnf');
  writeFileSync(configPath, opensslConfig(subjectAltName));
  const result = spawnSync(
    openssl,
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '825', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-config', configPath,
    ],
    { encoding: 'utf8' },
  );
  if (result.error?.code === 'ENOENT') {
    return {
      ok: false,
      error: '--lan skipped HTTPS: openssl was not found. HTTP is still on the LAN; '
        + 'the program may not start on a phone (SharedArrayBuffer is not legal on plain HTTP).',
    };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || String(result.status)).trim();
    return { ok: false, error: `--lan skipped HTTPS: openssl failed (${detail})` };
  }
  writeFileSync(sansPath, subjectAltName);
  return { ok: true, cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

/**
 * The lines `8bs run web` prints once the server is up.
 *
 * @param {{ local: string, lanUrls?: string[], lan?: boolean, lanWarning?: string | null }} info
 * @returns {string}
 */
export function serveBanner({ local, lanUrls = [], lan = false, lanWarning = null }) {
  const lines = [`serving ${local}`];
  if (lanWarning) lines.push(lanWarning);
  else if (lan && lanUrls.length === 0) {
    lines.push('--lan: no Wi-Fi IPv4 on this machine, but HTTP is listening on 0.0.0.0. Try http://<this-mac>:<port>/ if you know the address.');
  }
  for (const url of lanUrls) lines.push(`on your LAN: ${url}`);
  if (lanUrls.length > 0) {
    lines.push('  phone: same Wi-Fi (not a guest / client-isolated network). Open the http:// line; it redirects.');
    lines.push('  Safari will warn once on https — tap Advanced, then Proceed. Allow Node if macOS asks.');
  }
  lines.push(
    'in VS Code or Cursor: Cmd/Ctrl+Shift+P -> "Simple Browser: Show" -> paste that URL, '
      + 'to view it inside the editor.',
  );
  return `${lines.join('\n')}\n`;
}

function bind(server, host, port = 0) {
  return new Promise((resolveListen, reject) => {
    const onError = (err) => {
      server.off('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolveListen();
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
}

/**
 * HTTP on loopback, or on every interface when `lan` is set. HTTPS joins
 * that when openssl can mint a cert; non-loopback HTTP then redirects to it.
 *
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler
 * @param {{ lan?: boolean, port?: number, certDir?: string, openssl?: string }} [options]
 */
export async function listenWebDev(handler, { lan = false, port = 0, certDir, openssl } = {}) {
  let httpsPort = 0;
  const httpServer = createServer((req, res) => {
    if (httpsPort && !isLoopbackAddress(req.socket.remoteAddress)) {
      const host = String(req.headers.host ?? '').split(':')[0] || '127.0.0.1';
      res.writeHead(302, { Location: `https://${host}:${httpsPort}${req.url ?? '/'}` });
      res.end();
      return;
    }
    handler(req, res);
  });
  const host = lan ? '0.0.0.0' : '127.0.0.1';
  try {
    await bind(httpServer, host, port);
  } catch (err) {
    httpServer.close();
    if (err && err.code === 'EADDRINUSE') {
      return {
        error: `port ${port} is already in use. Stop the other 8bs run, or pass --port <n>.`,
        local: '',
        lanUrls: [],
        lan,
        lanWarning: null,
        close: async () => {},
      };
    }
    throw err;
  }
  const servers = [httpServer];
  const httpPort = httpServer.address().port;
  const local = `http://127.0.0.1:${httpPort}/`;
  const addresses = lan ? lanIPv4() : [];
  const lanUrls = addresses.map((ip) => `http://${ip}:${httpPort}/`);
  let lanWarning = null;
  const wantHttpsPort = port > 0 && port < 65535 ? port + 1 : 0;

  if (lan && addresses.length > 0) {
    const tls = createLanCertificate({ addresses, dir: certDir, openssl });
    if (!tls.ok) {
      lanWarning = tls.error;
    } else {
      const httpsServer = createHttpsServer({ key: tls.key, cert: tls.cert }, handler);
      try {
        await bind(httpsServer, '0.0.0.0', wantHttpsPort);
        servers.push(httpsServer);
        httpsPort = httpsServer.address().port;
        for (const ip of addresses) lanUrls.push(`https://${ip}:${httpsPort}/`);
      } catch (err) {
        httpsServer.close();
        if (err && err.code === 'EADDRINUSE') {
          lanWarning = `--lan skipped HTTPS: port ${wantHttpsPort || '(ephemeral)'} is already in use. HTTP is still on ${httpPort}.`;
        } else {
          await Promise.all(servers.map(closeServer));
          throw err;
        }
      }
    }
  }

  return {
    local,
    lanUrls,
    lan,
    lanWarning,
    close: () => Promise.all(servers.map(closeServer)),
  };
}
