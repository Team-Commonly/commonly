/**
 * The server says who it is once at start (TASK-345). Before this, nothing
 * reached Commonly until a tool ran, so an install that worked and one that
 * never started looked identical from the instance. This spawns the real entry
 * point against a local HTTP server. Only the refusal case speaks MCP, to show
 * the server still answers after its check-in was turned away.
 */
import { spawn } from 'child_process';
import http from 'http';
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
});
