/**
 * F571: two early `agent run` exits used to tell the instance nothing, so the
 * connect page waited forever. Each now sends the one report that can still
 * arrive: a sandbox refusal holds a token the server accepts, so it uses the
 * authenticated listen-blocked report; a refused token cannot authenticate, so
 * it uses the keyless run-stopped report. An unreachable instance gets neither,
 * since nothing can reach it.
 *
 * The process test is POSIX only (it spawns the CLI against a local stub).
 * Fake tokens, localhost only.
 */

import { describe, expect, jest, test } from '@jest/globals';
import { spawn } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { bootstrapAgentRecordFromEnv, TOKEN_REFUSED_CODE } from '../src/commands/agent.js';

const SOURCE = readFileSync(new URL('../src/commands/agent.js', import.meta.url), 'utf8');
const ACTION = SOURCE.slice(SOURCE.indexOf(".command('run <name>')"));

const failingClient = (err) => () => ({ get: jest.fn(async () => { throw err; }) });
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('bootstrapAgentRecordFromEnv marks a refused token (F571)', () => {
  const env = { COMMONLY_AGENT_TOKEN: 'cm_agent_fake_f571', COMMONLY_API_URL: 'http://127.0.0.1:9' };

  test('a 401 carries TOKEN_REFUSED_CODE', async () => {
    await expect(bootstrapAgentRecordFromEnv({
      name: 'newbie', env, clientFactory: failingClient(httpError(401)),
    })).rejects.toMatchObject({ code: TOKEN_REFUSED_CODE });
  });

  test.each([
    ['a network failure', new Error('fetch failed')],
    ['a 503', httpError(503)],
    ['a 403 from something in front of the app', httpError(403)],
  ])('%s is not a token refusal', async (_label, err) => {
    const thrown = await bootstrapAgentRecordFromEnv({
      name: 'newbie', env, clientFactory: failingClient(err),
    }).catch((e) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.code).not.toBe(TOKEN_REFUSED_CODE);
  });
});

// The block from `start` to the first process.exit(1) after it.
const beforeExit = (start) => {
  const at = ACTION.indexOf(start);
  expect(at).toBeGreaterThan(-1);
  const block = ACTION.slice(at);
  return block.slice(0, block.indexOf('process.exit(1)'));
};

describe('agent run wires each early exit to its report (F571)', () => {
  test('a refused token at first run sends run-stopped token-refused, after the terminal line', () => {
    const block = beforeExit('record = await bootstrapAgentRecordFromEnv(');
    expect(block).toMatch(/if \(err\.code === TOKEN_REFUSED_CODE\) \{\s*await reportRunStopped\(\{ agentName: agentArg, reason: 'token-refused' \}\);/);
    expect(block.indexOf('console.error(')).toBeLessThan(block.indexOf('reportRunStopped'));
  });

  test('--unsandboxed refused once the record names the adapter sends unsandboxed-refused', () => {
    const block = beforeExit("unsandboxedFlagRefusal(process.platform, { adapterName: record.adapter })");
    expect(block).toMatch(/await reportListenBlocked\(\s*createClient\(\{ instance: record\.instanceUrl, token: record\.runtimeToken \}\),\s*SANDBOX_STOPS\.flagRefused,\s*\);/);
    expect(block.indexOf('console.error(')).toBeLessThan(block.indexOf('reportListenBlocked'));
  });

  test('a host that cannot confine the seat sends sandbox-unavailable', () => {
    const block = beforeExit('if (hostRefusal) {');
    expect(block).toMatch(/await reportListenBlocked\(\s*createClient\(\{ instance: record\.instanceUrl, token: record\.runtimeToken \}\),\s*SANDBOX_STOPS\.hostRefused,\s*\);/);
    expect(block.indexOf('console.error(')).toBeLessThan(block.indexOf('reportListenBlocked'));
  });
});

const posixTest = process.platform === 'win32' ? test.skip : test;
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

const stubInstance = async (installationsStatus) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const path = req.url.split('?')[0];
      seen.push({
        method: req.method, path, authorization: req.headers.authorization || null, body: body ? JSON.parse(body) : null,
      });
      if (path === '/api/agents/runtime/installations') {
        res.writeHead(installationsStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'refused' }));
        return;
      }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { seen, server, url: `http://127.0.0.1:${server.address().port}` };
};

const runCli = (args, { env, cwd }) => new Promise((done) => {
  const child = spawn(process.execPath, [CLI, ...args], { env, cwd });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  child.on('close', (code) => { clearTimeout(timer); done({ code, stderr }); });
});

describe('the pasted command with a key the instance refuses (F571)', () => {
  const runAgainst = async (status) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cli-f571-')));
    mkdirSync(join(root, 'home'));
    const stub = await stubInstance(status);
    try {
      const result = await runCli(['agent', 'run', 'newbie'], {
        cwd: root,
        env: {
          HOME: join(root, 'home'),
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          COMMONLY_API_URL: stub.url,
          COMMONLY_AGENT_TOKEN: 'cm_agent_fake_f571',
          NO_UPDATE_NOTIFIER: '1',
        },
      });
      return { result, seen: stub.seen };
    } finally {
      await new Promise((done) => stub.server.close(done));
      rmSync(root, { recursive: true, force: true });
    }
  };

  posixTest('a 401 stops the run and sends run-stopped token-refused, keyless, with no token or URL', async () => {
    const { result, seen } = await runAgainst(401);
    expect(result.code).toBe(1);
    const report = seen.find((r) => r.path === '/api/stats/run-stopped');
    expect(report).toMatchObject({ method: 'POST', authorization: null });
    expect(report.body).toEqual({
      reason: 'token-refused',
      agentName: 'newbie',
      platform: process.platform,
      nodeMajor: Number.parseInt(process.versions.node, 10),
    });
    expect(JSON.stringify(report.body)).not.toContain('cm_agent_');
    expect(seen.some((r) => r.path === '/api/agents/runtime/listen-blocked')).toBe(false);
  }, 90_000);

  posixTest('a 503 is not a refused key, so it sends no run-stopped report', async () => {
    const { result, seen } = await runAgainst(503);
    expect(result.code).toBe(1);
    expect(seen.some((r) => r.path === '/api/stats/run-stopped')).toBe(false);
  }, 90_000);
});
