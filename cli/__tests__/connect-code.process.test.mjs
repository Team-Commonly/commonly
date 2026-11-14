/**
 * F525, the one pasted line end to end: `commonly agent run <name> --adapter
 * claude --api-url <url> --connect <code>` on a first run, against a local
 * stub instance. The run trades the code for the key (with no bearer), then
 * bootstraps with that key exactly as the env path does. A spent code stops
 * the run with one plain line before anything else is asked.
 *
 * POSIX only: the fake harness is a shell script. Fake code and key, localhost only.
 */

import { spawn } from 'child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const posixTest = process.platform === 'win32' ? test.skip : test;
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const CODE = `cmc_${'Q'.repeat(22)}`;
const KEY = 'cm_agent_fake_f525_key';

const stubInstance = async ({ redeem }) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const path = req.url.split('?')[0];
      seen.push({ method: req.method, path, auth: req.headers.authorization || null, body: body ? JSON.parse(body) : null });
      res.writeHead(path === '/api/agents/runtime/connect-code' ? redeem.status : 200, { 'content-type': 'application/json' });
      if (path === '/api/agents/runtime/connect-code') {
        res.end(JSON.stringify(redeem.body));
        return;
      }
      if (path === '/api/agents/runtime/installations') {
        res.end(JSON.stringify({
          agentName: 'newbie',
          instanceId: 'default',
          installations: [{ type: 'installation', status: 'active', podId: 'pod-f525', agentName: 'newbie', instanceId: 'default' }],
        }));
        return;
      }
      if (path === '/api/agents/runtime/events') {
        res.end(JSON.stringify({ events: [] }));
        return;
      }
      res.end(JSON.stringify({}));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { seen, server, url: `http://127.0.0.1:${server.address().port}` };
};

// Runs until it exits, or until `until(seen)` holds (then it is stopped).
const run = (args, { env, cwd, seen, until = () => false }) => new Promise((done) => {
  const child = spawn(process.execPath, [CLI, ...args], { env, cwd });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const watch = setInterval(() => { if (until(seen)) child.kill('SIGTERM'); }, 100);
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  child.on('close', (code) => { clearInterval(watch); clearTimeout(timer); done({ code, stdout, stderr }); });
});

describe('the one pasted line with a connect code (F525)', () => {
  let root;
  let stub;
  const envFor = () => ({
    HOME: join(root, 'home'),
    PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
    NO_UPDATE_NOTIFIER: '1',
  });
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cli-f525-')));
    mkdirSync(join(root, 'home'));
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'work'));
    const claude = join(root, 'bin', 'claude');
    writeFileSync(claude, '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.0 (Claude Code)"; exit 0 ;;\nesac\nexit 0\n');
    chmodSync(claude, 0o755);
  });
  afterEach(async () => {
    await new Promise((done) => stub.server.close(done));
    rmSync(root, { recursive: true, force: true });
  });

  posixTest('trades the code for the key, then connects with that key', async () => {
    stub = await stubInstance({ redeem: { status: 200, body: { token: KEY } } });
    const result = await run(
      ['agent', 'run', 'newbie', '--adapter', 'claude', '--api-url', stub.url, '--connect', CODE],
      { cwd: join(root, 'work'), env: envFor(), seen: stub.seen, until: (seen) => seen.some((r) => r.path === '/api/agents/runtime/events') },
    );
    const redeem = stub.seen.find((r) => r.path === '/api/agents/runtime/connect-code');
    expect(redeem).toEqual({ method: 'POST', path: '/api/agents/runtime/connect-code', auth: null, body: { code: CODE } });
    const whoIs = stub.seen.find((r) => r.path === '/api/agents/runtime/installations');
    expect(whoIs.auth).toBe(`Bearer ${KEY}`);
    expect(stub.seen.find((r) => r.path === '/api/agents/runtime/events').auth).toBe(`Bearer ${KEY}`);
    const saved = JSON.parse(readFileSync(join(root, 'home', '.commonly', 'tokens', 'newbie.json'), 'utf8'));
    expect(saved.runtimeToken).toBe(KEY);
    expect(saved.instanceUrl).toBe(stub.url);
    // Neither the code nor the key is echoed to the terminal; the code isn't saved.
    expect(result.stdout + result.stderr).not.toContain(CODE);
    expect(result.stdout + result.stderr).not.toContain(KEY);
    expect(result.stdout).toContain('from the connect code');
    expect(JSON.stringify(saved)).not.toContain(CODE);
  }, 90_000);

  const savedAgent = (instanceUrl) => {
    mkdirSync(join(root, 'home', '.commonly', 'tokens'), { recursive: true });
    writeFileSync(join(root, 'home', '.commonly', 'tokens', 'newbie.json'), JSON.stringify({
      agentName: 'newbie', instanceId: 'default', podId: 'pod-f525', instanceUrl,
      runtimeToken: 'cm_agent_fake_saved_key', adapter: 'claude',
    }), { mode: 0o600 });
  };

  posixTest('the line again from history, its code expired, runs the agent already saved here', async () => {
    stub = await stubInstance({ redeem: { status: 404, body: { code: 'connect_code_unknown' } } });
    savedAgent(stub.url);
    const result = await run(
      ['agent', 'run', 'newbie', '--adapter', 'claude', '--api-url', stub.url, '--connect', CODE],
      { cwd: join(root, 'work'), env: envFor(), seen: stub.seen, until: (seen) => seen.some((r) => r.path === '/api/agents/runtime/events') },
    );
    expect(result.stdout).toContain("this line's connect code wasn't used (unknown), so this run uses the saved token");
    expect(stub.seen.find((r) => r.path === '/api/agents/runtime/events').auth).toBe('Bearer cm_agent_fake_saved_key');
  }, 90_000);

  posixTest('a line for another instance than the saved agent of that name stops before redeeming', async () => {
    stub = await stubInstance({ redeem: { status: 200, body: { token: KEY } } });
    savedAgent('https://elsewhere.example.test');
    const result = await run(
      ['agent', 'run', 'newbie', '--adapter', 'claude', '--api-url', stub.url, '--connect', CODE],
      { cwd: join(root, 'work'), env: envFor(), seen: stub.seen },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('This computer already runs an agent called newbie on https://elsewhere.example.test');
    expect(stub.seen).toEqual([]);
  }, 90_000);

  posixTest('an --api-url that is not an http(s) address stops with one line', async () => {
    stub = await stubInstance({ redeem: { status: 200, body: { token: KEY } } });
    const result = await run(
      ['agent', 'run', 'newbie', '--adapter', 'claude', '--api-url', 'api.commonly.me', '--connect', CODE],
      { cwd: join(root, 'work'), env: envFor(), seen: stub.seen },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--api-url needs an http(s) address, such as https://api.commonly.me.');
    expect(stub.seen).toEqual([]);
  }, 90_000);

  posixTest('a spent code stops with one plain line and asks nothing else', async () => {
    stub = await stubInstance({ redeem: { status: 410, body: { code: 'connect_code_used' } } });
    const result = await run(
      ['agent', 'run', 'newbie', '--adapter', 'claude', '--api-url', stub.url, '--connect', CODE],
      { cwd: join(root, 'work'), env: envFor(), seen: stub.seen },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('newbie has already connected from a computer, so this line\'s code is spent.');
    expect(stub.seen.map((r) => r.path)).toEqual(['/api/agents/runtime/connect-code']);
    expect(existsSync(join(root, 'home', '.commonly', 'tokens', 'newbie.json'))).toBe(false);
  }, 90_000);
});
