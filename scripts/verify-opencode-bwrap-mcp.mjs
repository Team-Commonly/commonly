/** Actual OpenCode adapter + stdio Commonly MCP transport in a Linux namespace. */
import assert from 'assert/strict';
import { createServer } from 'http';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import opencode from '../cli/src/lib/adapters/opencode.js';
import { commonlyMcpServer } from '../cli/src/lib/default-environment.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'commonly-bwrap-mcp-'));
const workspace = join(root, 'workspace');
const mcpHome = join(root, 'mcp-home');
const packageDir = join(mcpHome, '0.3.13/node_modules/@commonlyai/mcp');
await mkdir(workspace);
await mkdir(packageDir, { recursive: true });
await cp(join(repo, 'commonly-mcp'), packageDir, { recursive: true });
await writeFile(join(mcpHome, 'current'), '0.3.13\n');
await writeFile(join(mcpHome, '.warm.lock'), 'probe');
process.env.COMMONLY_MCP_HOME = mcpHome;
const binary = join(workspace, 'opencode');
await cp(join(repo, 'cli/__tests__/fixtures/opencode-mcp-probe.mjs'), binary);
await chmod(binary, 0o755);
const keyFile = join(root, 'key');
await writeFile(keyFile, 'fake-provider-key', { mode: 0o600 });

let apiHits = 0;
let providerHits = 0;
const api = createServer((req, res) => {
  apiHits += 1;
  assert.equal(req.headers.authorization, 'Bearer cm_agent_mcp_probe');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, path: req.url }));
});
const provider = createServer((req, res) => {
  providerHits += 1;
  assert.equal(req.headers.authorization, 'Bearer fake-provider-key');
  res.setHeader('content-type', 'application/json');
  res.end('{"data":[]}');
});
const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const apiUrl = `http://127.0.0.1:${await listen(api)}`;
const providerUrl = `http://127.0.0.1:${await listen(provider)}/v1`;
try {
  const result = await opencode.spawn('MCP egress probe', {
    cwd: workspace,
    agentName: 'mcp-probe',
    runtimeToken: 'cm_agent_mcp_probe',
    instanceUrl: apiUrl,
    env: { PATH: process.env.PATH },
    timeoutMs: 20_000,
    _binaryPath: binary,
    _opencodeHomeRoot: join(root, 'state'),
    environment: {
      model: 'test',
      provider: { id: 'local', baseURL: providerUrl, keyFile },
      sandbox: { trust: 'public', mode: 'bwrap' },
      mcp: [commonlyMcpServer()],
    },
  });
  const observed = JSON.parse(result.text);
  assert.equal(observed.provider, 200);
  assert.ok(observed.mcpTools > 0);
  assert.equal(observed.apiUrl, 'http://127.0.0.1:8766');
  assert.equal(observed.context.isError, undefined);
  assert.equal(observed.post.isError, undefined);
  assert.equal(apiHits, 2);
  assert.equal(providerHits, 1);
  process.stdout.write(`OpenCode bwrap provider + Commonly MCP: ${observed.mcpTools} tools, ${apiHits} API calls\n`);
} finally {
  api.closeAllConnections();
  provider.closeAllConnections();
  await Promise.all([close(api), close(provider)]);
  await rm(root, { recursive: true, force: true });
}
