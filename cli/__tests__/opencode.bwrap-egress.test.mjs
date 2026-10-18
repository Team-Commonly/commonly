import { spawn, spawnSync } from 'child_process';
import { createServer } from 'http';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { detectBwrap, wrapArgvWithBwrap } from '../src/lib/sandbox/bwrap.js';
import { startProviderProxy } from '../src/lib/provider-proxy.js';

const LOOPBACK_BRIDGE = fileURLToPath(new URL('../src/lib/sandbox/opencode-loopback.mjs', import.meta.url));
const PORT = 8765;
const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { timeout: 15_000 });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});
const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

test('public bwrap reaches its provider proxy but refuses other host and internet ports', async () => {
  if (process.platform !== 'linux' || !detectBwrap().available
    || spawnSync('ip', ['-V']).status !== 0) return;

  const root = await mkdtemp(join(tmpdir(), 'commonly-egress-'));
  const privateRoot = await mkdtemp(join(tmpdir(), 'commonly-egress-key-'));
  const workspace = join(root, 'workspace');
  const proxyDir = join(root, 'proxy');
  const keyFile = join(privateRoot, 'key');
  const tokenFile = join(proxyDir, 'token');
  const socketPath = join(proxyDir, 'proxy.sock');
  const childFile = join(workspace, 'probe.mjs');
  await Promise.all([mkdir(workspace), mkdir(proxyDir)]);
  await writeFile(keyFile, 'upstream-key', { mode: 0o600 });
  await chmod(keyFile, 0o600);
  const upstream = createServer((req, res) => {
    if (req.url !== '/v1/models' || req.headers.authorization !== 'Bearer upstream-key') {
      res.writeHead(403).end();
    } else res.writeHead(200).end('models');
  });
  const unrelated = createServer((_req, res) => res.writeHead(200).end('wrong-port'));
  let proxy;
  try {
    const upstreamPort = await listen(upstream);
    const unrelatedPort = await listen(unrelated);
    proxy = await startProviderProxy({
      provider: { baseURL: `http://127.0.0.1:${upstreamPort}/v1` },
      keyFile, tokenFile, socketPath, isolatedPort: PORT,
    });
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    await writeFile(childFile, `
      import { readFileSync } from 'fs';
      import { get } from 'http';
      import { connect } from 'net';
      import { spawnSync } from 'child_process';
      const token = readFileSync(process.argv[2], 'utf8');
      const request = (port, path, headers = {}) => new Promise((resolve) => {
        const req = get({ hostname: '127.0.0.1', port, path, headers, timeout: 1000 }, (res) => {
          res.resume(); res.on('end', () => resolve(res.statusCode));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(0));
      });
      const internet = await new Promise((resolve) => {
        const conn = connect({ host: '8.8.8.8', port: 53, timeout: 1000 });
        conn.on('connect', () => { conn.destroy(); resolve(false); });
        conn.on('timeout', () => { conn.destroy(); resolve(true); });
        conn.on('error', () => resolve(true));
      });
      const allowed = await request(${PORT}, '/v1/models', { authorization: 'Bearer ' + token });
      const otherHostPort = await request(${unrelatedPort}, '/');
      const netAdminDropped = spawnSync('ip', ['link', 'set', 'lo', 'down']).status !== 0;
      const capabilitiesDropped = /^CapEff:\\s*0+$/m.test(readFileSync('/proc/self/status', 'utf8'));
      process.stdout.write(JSON.stringify({ allowed, otherHostPort, internet, netAdminDropped, capabilitiesDropped }));
    `);
    const argv = wrapArgvWithBwrap([
      process.execPath, LOOPBACK_BRIDGE, socketPath, String(PORT),
      process.execPath, childFile, tokenFile,
    ], { sandbox: { network: { policy: 'restricted' } } }, {
      workspacePath: workspace,
      readOnlyPaths: [proxyDir, process.execPath, LOOPBACK_BRIDGE],
      optionalReadOnlyPaths: ['/usr/sbin', '/sbin'],
      enableLoopback: true,
    });
    const result = await run(argv[0], argv.slice(1));
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      allowed: 200, otherHostPort: 0, internet: true,
      netAdminDropped: true, capabilitiesDropped: true,
    });
  } finally {
    await proxy?.close();
    await Promise.all([close(upstream), close(unrelated)]);
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
}, 25_000);
