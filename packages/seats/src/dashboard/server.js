/**
 * Local dashboard server over node:http. Read-only: it serves what the trace
 * store and a compat results.json already hold, and never writes either.
 *
 * Loopback by default, because a trace holds agent output. The Host check
 * below closes the other loopback hole: DNS rebinding, where a page on a
 * hostile domain resolves that domain to 127.0.0.1 and reads the dashboard.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import { createTraceStore } from '../trace/store.js';
import { OUTCOMES, renderRuns, renderRun, renderCompat, renderError } from './render.js';

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
});
const RUN_ID = /^[A-Za-z0-9_-]{6,64}$/;
const RUNS_LIMIT = 500;

export const isLoopbackHost = (host) => {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  return isIP(h) === 4 && h.startsWith('127.');
};

// Host header → hostname without the port, tolerating "[::1]:8080".
const hostnameOf = (header) => {
  const value = String(header || '');
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
  return value.split(':')[0];
};

/** Read results.json on every request, so a rerun of the compat suite shows up without a restart. */
export const loadCompat = (compatPath) => {
  if (!compatPath) return { results: null, error: null };
  if (!existsSync(compatPath)) return { results: null, error: `No results file at ${compatPath}` };
  try {
    return { results: JSON.parse(readFileSync(compatPath, 'utf8')), error: null };
  } catch {
    return { results: null, error: `Could not parse ${compatPath} as JSON` };
  }
};

const send = (res, status, type, body, extra = {}) => {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
  res.end(body);
};
const html = (res, status, body) => send(res, status, 'text/html; charset=utf-8', body);
const json = (res, status, value) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));

const filterRuns = (runs, outcome) => (OUTCOMES.includes(outcome) ? runs.filter((r) => r.outcome === outcome) : runs);

const route = ({ store, compatPath, now }) => (req, res) => {
  const url = new URL(req.url, 'http://local');
  const api = url.pathname.startsWith('/api/');
  const path = api ? url.pathname.slice(4) : url.pathname;
  const notFound = (message) => (api ? json(res, 404, { error: message }) : html(res, 404, renderError(404, message)));

  if (path === '/' || (api && path === '/runs')) {
    const outcome = url.searchParams.get('outcome');
    const runs = store.listRuns({ limit: RUNS_LIMIT });
    if (api) return json(res, 200, { runs: filterRuns(runs, outcome) });
    return html(res, 200, renderRuns(runs, { outcome, now: now(), refresh: url.searchParams.get('refresh') !== '0' }));
  }

  const match = path.match(/^\/runs\/([^/]+)$/);
  if (match) {
    let runId;
    try { runId = decodeURIComponent(match[1]); } catch { return notFound('No such run'); }
    const events = RUN_ID.test(runId) ? store.readRun(runId) : null;
    if (!events) return notFound('No such run');
    if (api) return json(res, 200, { runId, events });
    return html(res, 200, renderRun(events, { runId }));
  }

  if (path === '/compat') {
    const { results, error } = loadCompat(compatPath);
    if (api) return results ? json(res, 200, results) : json(res, 404, { error: error || 'No compat results configured' });
    return html(res, 200, renderCompat(results, { error }));
  }

  return notFound('No such page');
};

/**
 * Start the dashboard. Resolves to `{ url, close }`; `close()` resolves once
 * the socket is closed. A non-loopback `host` is refused unless `allowRemote`.
 */
export const startDashboard = ({ store, compatPath = null, port = 0, host = '127.0.0.1', allowRemote = false, now = Date.now } = {}) => {
  if (!store || typeof store.listRuns !== 'function' || typeof store.readRun !== 'function') {
    return Promise.reject(new Error('startDashboard needs a trace store'));
  }
  if (!allowRemote && !isLoopbackHost(host)) {
    return Promise.reject(new Error(`refusing to bind ${host}: the dashboard serves agent output; pass allowRemote: true to expose it`));
  }
  const handle = route({ store, compatPath, now });
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }
    if (!allowRemote && !isLoopbackHost(hostnameOf(req.headers.host))) {
      return send(res, 421, 'text/plain; charset=utf-8', 'Misdirected Request');
    }
    try {
      return handle(req, res);
    } catch {
      // No stack on the page: an error message can quote a path or a trace line.
      return html(res, 500, renderError(500, 'The dashboard could not render this page'));
    }
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const { address, port: bound } = server.address();
      const shown = address.includes(':') ? `[${address}]` : address;
      resolvePromise({
        url: `http://${shown}:${bound}`,
        close: () => new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
};

export const parseArgs = (argv) => {
  const opts = { root: null, compat: null, port: 0, host: '127.0.0.1', allowRemote: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--root') opts.root = next();
    else if (arg === '--compat') opts.compat = next();
    else if (arg === '--host') opts.host = next();
    else if (arg === '--allow-remote') opts.allowRemote = true;
    else if (arg === '--port') {
      opts.port = Number(next());
      if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('--port must be 0-65535');
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.root) throw new Error('--root <traceRoot> is required');
  return opts;
};

const main = async () => {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\nusage: node src/dashboard/server.js --root <traceRoot> [--compat <results.json>] [--port N]\n`);
    process.exit(2);
  }
  // createTraceStore creates its root; a mistyped --root should fail, not mint an empty store.
  if (!existsSync(opts.root)) {
    process.stderr.write(`no trace store at ${opts.root}\n`);
    process.exit(2);
  }
  const store = createTraceStore({ root: resolve(opts.root) });
  const dashboard = await startDashboard({
    store, compatPath: opts.compat && resolve(opts.compat), port: opts.port, host: opts.host, allowRemote: opts.allowRemote,
  });
  process.stdout.write(`${dashboard.url}\n`);
  const stop = () => dashboard.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
