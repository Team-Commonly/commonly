/** Shared helpers for the measurement scripts. */
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CREDENTIAL = 'bench-upstream-credential-0123456789';
export const ADMIN_TOKEN = 'bench-admin-token-0123456789';
export const GRANT_TOKEN = 'bench-grant-token-0123456789abcdef';

export const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

export const writeConfig = ({ port, upstreamUrl }) => {
  const dir = mkdtempSync(join(tmpdir(), 'grants-bench-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    listen: `127.0.0.1:${port}`,
    upstreamUrl,
    auditPath: join(dir, 'audit.jsonl'),
    approvalTimeoutMs: 5000,
    grants: [{
      runId: 'bench', token: GRANT_TOKEN, tools: ['read_issue', 'list_issues'], approve: [],
      expiresAt: '2099-01-01T00:00:00Z', maxCalls: 1_000_000_000,
    }],
  }));
  return { path, dir };
};

export const brokerEnv = () => ({
  PATH: process.env.PATH,
  GRANTS_UPSTREAM_CREDENTIAL: CREDENTIAL,
  GRANTS_ADMIN_TOKEN: ADMIN_TOKEN,
  ...(process.env.GOMAXPROCS ? { GOMAXPROCS: process.env.GOMAXPROCS } : {}),
});

/** POST one JSON-RPC message; resolves {status, body}. `agent` false = fresh connection. */
export const post = (port, body, { agent = false, token = GRANT_TOKEN } = {}) => new Promise((resolve, reject) => {
  const text = JSON.stringify(body);
  const req = request({
    host: '127.0.0.1', port, path: '/mcp', method: 'POST', agent,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), authorization: `Bearer ${token}` },
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end(text);
});

export const startUpstream = async (here) => {
  const port = await freePort();
  const child = spawn(process.execPath, [join(here, '..', 'conformance', 'fake-upstream.js')], {
    env: { PATH: process.env.PATH, FAKE_UPSTREAM_CREDENTIAL: CREDENTIAL, FAKE_UPSTREAM_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  return { child, port, url: `http://127.0.0.1:${port}/mcp` };
};

export const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
