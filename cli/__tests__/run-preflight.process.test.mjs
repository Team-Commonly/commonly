/**
 * F515, the pasted connect command end to end: `commonly agent run` on a first
 * run, against a local stub instance, with a Claude Code that is installed but
 * signed out. The run stops before it starts waiting, prints one plain fix
 * line, tells the instance the reason code (and nothing else), never polls,
 * and saves no token, so the next paste is a first run again.
 *
 * POSIX only: the fake harness is a shell script. The decision itself is
 * covered on every OS by run-preflight.test.mjs. Fake token, localhost only.
 */

import { spawn } from 'child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const posixTest = process.platform === 'win32' ? test.skip : test;
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

const stubInstance = async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const path = req.url.split('?')[0];
      seen.push({ method: req.method, path, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (path === '/api/agents/runtime/installations') {
        res.end(JSON.stringify({
          agentName: 'newbie',
          instanceId: 'default',
          installations: [{ type: 'installation', status: 'active', podId: 'pod-f515', agentName: 'newbie', instanceId: 'default' }],
        }));
        return;
      }
      res.end(JSON.stringify({ recorded: true }));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { seen, server, url: `http://127.0.0.1:${server.address().port}` };
};

const run = (args, { env, cwd }) => new Promise((done) => {
  const child = spawn(process.execPath, [CLI, ...args], { env, cwd });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  child.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
});

describe('the pasted connect command with a signed-out Claude Code (F515)', () => {
  let root;
  let stub;
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cli-f515-')));
    mkdirSync(join(root, 'home'));
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'work'));
    // Installed (it answers --version) but signed out: `claude auth status`
    // exits 1, as the real one does.
    const claude = join(root, 'bin', 'claude');
    writeFileSync(claude, '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.0 (Claude Code)"; exit 0 ;;\n  auth) exit 1 ;;\nesac\nexit 0\n');
    chmodSync(claude, 0o755);
    stub = await stubInstance();
  });
  afterEach(async () => {
    await new Promise((done) => stub.server.close(done));
    rmSync(root, { recursive: true, force: true });
  });

  posixTest('stops before waiting, prints the fix, and tells the instance the reason code only', async () => {
    const result = await run(['agent', 'run', 'newbie', '--adapter', 'claude'], {
      cwd: join(root, 'work'),
      env: {
        HOME: join(root, 'home'),
        PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
        COMMONLY_API_URL: stub.url,
        COMMONLY_AGENT_TOKEN: 'cm_agent_fake_f515',
        NO_UPDATE_NOTIFIER: '1',
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Claude Code is installed but not signed in on this computer. '
      + 'Run claude once to sign in, then run this line again.');
    const report = stub.seen.find((r) => r.path === '/api/agents/runtime/listen-blocked');
    expect(report).toEqual({
      method: 'POST', path: '/api/agents/runtime/listen-blocked', body: { reason: 'harness-signed-out', harness: 'claude' },
    });
    // It never started waiting, and kept no token for a second run to reuse.
    expect(stub.seen.some((r) => r.path === '/api/agents/runtime/events')).toBe(false);
    expect(existsSync(join(root, 'home', '.commonly', 'tokens', 'newbie.json'))).toBe(false);
  }, 90_000);
});
