/**
 * The server says who it is once at start (TASK-345). Before this, nothing
 * reached Commonly until a tool ran, so an install that worked and one that
 * never started looked identical from the instance. This spawns the real entry
 * point against a local HTTP server. Only the refusal case speaks MCP, to show
 * the server still answers after its check-in was turned away.
 */
import { spawn } from 'child_process';
import http from 'http';
import net from 'net';
import { fileURLToPath } from 'url';
import path from 'path';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

const startApi = (status) => new Promise((resolve) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, ua: req.headers['user-agent'] });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { installations: [] } : { message: 'refused' }));
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }));
});

const run = (url) => {
  const child = spawn(process.execPath, [ENTRY], {
    env: { PATH: process.env.PATH, COMMONLY_API_URL: url, COMMONLY_AGENT_TOKEN: 'cm_agent_startup_test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  return { child, out };
};

const waitFor = async (check, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => { setTimeout(r, 25); });
  }
  return false;
};

// A slow network in front of the API: a connection is held for `delayMs`
// before it reaches the server, and dropped if the client goes first. That
// is a request still in its handshake when `claude mcp list` closes the
// server: it never arrives, so the token is never stamped.
const slowLink = (target, delayMs) => new Promise((resolve) => {
  const proxy = net.createServer((client) => {
    const held = [];
    let gone = false;
    const hold = (chunk) => held.push(chunk);
    client.on('data', hold);
    client.on('close', () => { gone = true; });
    client.on('error', () => {});
    setTimeout(() => {
      if (gone) return;
      const upstream = net.connect(Number(new URL(target).port), '127.0.0.1', () => {
        client.off('data', hold);
        for (const chunk of held) upstream.write(chunk);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
    }, delayMs);
  });
  proxy.listen(0, '127.0.0.1', () => resolve({ proxy, url: `http://127.0.0.1:${proxy.address().port}` }));
});

const initialize = (child) => child.stdin.write(`${JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'health-check', version: '0' } },
})}\n`);

describe('startup', () => {
  it('makes one authenticated call before any tool runs', async () => {
    const api = await startApi(200);
    const { child, out } = run(api.url);
    try {
      expect(await waitFor(() => api.seen.length > 0)).toBe(true);
      expect(api.seen[0]).toMatchObject({
        method: 'GET',
        url: '/api/agents/runtime/installations',
        auth: 'Bearer cm_agent_startup_test',
      });
      expect(api.seen[0].ua).toMatch(/^commonly-mcp\//);
      // stdout is the MCP transport; the call must not write to it.
      expect(out.stdout).toBe('');
    } finally {
      child.kill();
      api.server.close();
    }
  });

  it('keeps serving when Commonly refuses that call, and says so on stderr only', async () => {
    const api = await startApi(401);
    const { child, out } = run(api.url);
    try {
      expect(await waitFor(() => /could not reach Commonly at start: HTTP 401: refused/.test(out.stderr))).toBe(true);
      expect(child.exitCode).toBeNull();
      expect(out.stdout).toBe('');
      expect(out.stderr).not.toContain('cm_agent_startup_test');
      // Still an MCP server: it answers initialize and lists its tools.
      const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
      send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'startup-test', version: '0' } } });
      expect(await waitFor(() => /"id":1/.test(out.stdout))).toBe(true);
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/list' });
      expect(await waitFor(() => /"id":2/.test(out.stdout))).toBe(true);
      const listed = out.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((m) => m.id === 2);
      expect(listed.result.tools.length).toBeGreaterThan(0);
    } finally {
      child.kill();
      api.server.close();
    }
  });
  // Growth's walk, 11-04: `claude mcp list` printed "Connected" and closed the
  // server before its check-in landed, so the person who added it looked like
  // one who never had. The check-in now lands before initialize is answered.
  it('a health check that closes the server as soon as initialize answers has still checked in', async () => {
    const api = await startApi(200);
    const link = await slowLink(api.url, 300);
    const { child, out } = run(link.url);
    try {
      initialize(child);
      expect(await waitFor(() => /"id":1/.test(out.stdout))).toBe(true);
      // The health check is done: it kills the server at once.
      child.kill('SIGKILL');
      await new Promise((r) => { setTimeout(r, 600); });
      expect(api.seen).toHaveLength(1);
      expect(api.seen[0]).toMatchObject({ method: 'GET', url: '/api/agents/runtime/installations' });
    } finally {
      child.kill('SIGKILL');
      api.server.close();
      link.proxy.close();
    }
  });

  // A slow or dead API never holds startup for more than about a second.
  it('answers initialize within about a second when Commonly does not answer the check-in', async () => {
    const silent = net.createServer(() => {});
    await new Promise((r) => { silent.listen(0, '127.0.0.1', r); });
    const { child, out } = run(`http://127.0.0.1:${silent.address().port}`);
    try {
      // Let the process come up first, so the clock measures the wait alone.
      await new Promise((r) => { setTimeout(r, 1500); });
      const sent = Date.now();
      initialize(child);
      expect(await waitFor(() => /"id":1/.test(out.stdout), 4000)).toBe(true);
      expect(Date.now() - sent).toBeLessThan(1800);
    } finally {
      child.kill('SIGKILL');
      silent.close();
    }
  });
});
