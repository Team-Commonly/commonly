/**
 * Starts the fake upstream and either broker as subprocesses, and records every
 * broker response so the suite can scan them all for the upstream credential.
 *
 * BROKER=ts|go picks the implementation. BROKER_CMD (a JSON array) overrides
 * the command outright, e.g. to run the suite against a single-file build.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..');

export const CREDENTIAL = `upstream-cred-${randomBytes(12).toString('hex')}`;
export const ADMIN_TOKEN = `admin-${randomBytes(12).toString('hex')}`;
export const newToken = () => `grant-${randomBytes(16).toString('hex')}`;

export const brokerCommand = (kind = process.env.BROKER || 'ts') => {
  if (process.env.BROKER_CMD) return JSON.parse(process.env.BROKER_CMD);
  if (kind === 'ts') return [process.env.NODE_BIN || process.execPath, join(ROOT, 'ts', 'broker.js')];
  if (kind === 'go') return [process.env.BROKER_BIN || join(ROOT, 'go', 'broker')];
  throw new Error(`BROKER must be ts or go, got ${kind}`);
};

/** Every broker HTTP exchange the suite made, headers and body, for the leak scan. */
export const transcript = [];

const children = new Set();
process.on('exit', () => { for (const c of children) c.kill('SIGKILL'); });

const waitForListening = (child, label) => new Promise((resolve, reject) => {
  let out = '';
  let err = '';
  const timer = setTimeout(() => reject(new Error(`${label} did not start: ${err}`)), 10_000);
  child.stdout.on('data', (d) => {
    out += d;
    const line = out.split('\n').find((l) => l.includes('"listening"'));
    if (line) { clearTimeout(timer); resolve(JSON.parse(line).listening); }
  });
  child.stderr.on('data', (d) => {
    err += d;
    // BROKER_STDERR keeps a child's stderr, e.g. race-detector reports from a -race build.
    if (process.env.BROKER_STDERR) appendFileSync(process.env.BROKER_STDERR, d);
  });
  child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${label} exited ${code}: ${err}`)); });
});

const launch = async (cmd, env, label) => {
  const child = spawn(cmd[0], cmd.slice(1), { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  const addr = await waitForListening(child, label);
  return { child, base: `http://${addr}` };
};

const stopper = (child) => () => new Promise((resolve) => {
  if (child.exitCode !== null) return resolve();
  child.once('exit', resolve);
  child.kill('SIGTERM');
});

export const startUpstream = async () => {
  const { child, base } = await launch([process.execPath, join(here, 'fake-upstream.js')], { FAKE_UPSTREAM_CREDENTIAL: CREDENTIAL }, 'upstream');
  return {
    base,
    seen: async () => (await fetch(`${base}/_seen`)).json(),
    stop: stopper(child),
  };
};

export const grant = (overrides = {}) => ({
  runId: `run-${randomBytes(4).toString('hex')}`,
  token: newToken(),
  tools: ['read_issue', 'list_issues', 'create_issue'],
  approve: ['create_issue'],
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  maxCalls: 100,
  ...overrides,
});

export const startBroker = async ({ upstream, grants = [], approvalTimeoutMs = 5_000, extraConfig = {} }) => {
  const dir = mkdtempSync(join(tmpdir(), 'grants-conf-'));
  const auditPath = join(dir, 'audit.jsonl');
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    listen: '127.0.0.1:0', upstreamUrl: `${upstream.base}/mcp`, auditPath, approvalTimeoutMs, grants, ...extraConfig,
  }));
  const { child, base } = await launch([...brokerCommand(), '--config', configPath], {
    GRANTS_UPSTREAM_CREDENTIAL: CREDENTIAL, GRANTS_ADMIN_TOKEN: ADMIN_TOKEN,
  }, 'broker');

  const exchange = async (path, { method = 'POST', token, body, rawBody } = {}) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, {
      method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    transcript.push({ path, status: res.status, headers: JSON.stringify([...res.headers]), text });
    return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : undefined };
  };

  let nextId = 1;
  const rpc = (token, method, params) => exchange('/mcp', { token, body: { jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) } });
  const admin = (method, path, body) => exchange(path, { method, token: ADMIN_TOKEN, body });

  return { base, auditPath, configPath, exchange, rpc, admin, stop: stopper(child) };
};

/** Start a broker that should refuse to start; resolves its exit code. */
export const startBrokerExpectingExit = ({ upstream, grants }) => new Promise((resolve) => {
  const dir = mkdtempSync(join(tmpdir(), 'grants-conf-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ listen: '127.0.0.1:0', upstreamUrl: `${upstream.base}/mcp`, auditPath: join(dir, 'a.jsonl'), grants }));
  const cmd = brokerCommand();
  const child = spawn(cmd[0], [...cmd.slice(1), '--config', configPath], {
    env: { PATH: process.env.PATH, GRANTS_UPSTREAM_CREDENTIAL: CREDENTIAL, GRANTS_ADMIN_TOKEN: ADMIN_TOKEN }, stdio: 'ignore',
  });
  const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('still running'); }, 5_000);
  child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
});

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const waitFor = async (probe, { timeoutMs = 5_000, everyMs = 20 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(everyMs);
  }
};
