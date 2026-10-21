/**
 * One version, one name, everywhere the package is described.
 *
 * The MCP Registry lists this package from server.json and verifies it by
 * package.json's mcpName, and clients see the handshake's serverInfo. Until
 * 0.3.14 the handshake and the User-Agent carried a hard-coded 0.1.9 while the
 * package was at 0.3.13, so these are checked against package.json, the one
 * source, rather than against each other.
 */
import { jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { PACKAGE_VERSION } from '../src/version.js';
import { request } from '../src/client.js';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const pkg = read('../package.json');
const server = read('../server.json');

describe('server.json agrees with package.json', () => {
  it('names the package the registry will verify', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({
      registryType: 'npm',
      identifier: pkg.name,
      version: pkg.version,
      transport: { type: 'stdio' },
    });
  });

  it('carries the package version', () => {
    expect(server.version).toBe(pkg.version);
  });

  it('says what package.json says, within the registry limit', () => {
    expect(server.description).toBe(pkg.description);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('declares exactly the variables loadConfig requires, with the token secret', () => {
    const vars = Object.fromEntries(server.packages[0].environmentVariables.map((v) => [v.name, v]));
    expect(Object.keys(vars).sort()).toEqual(['COMMONLY_AGENT_TOKEN', 'COMMONLY_API_URL']);
    expect(vars.COMMONLY_AGENT_TOKEN).toMatchObject({ isRequired: true, isSecret: true });
    expect(vars.COMMONLY_API_URL).toMatchObject({ isRequired: true });
  });
});

describe('the running server reports the package version', () => {
  it('PACKAGE_VERSION is package.json\'s version', () => {
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it('sends it in the User-Agent', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
    await request({ baseUrl: 'https://x.example', token: 'cm_agent_t' }, {
      method: 'GET', path: '/api/agents/runtime/memory', _fetchImpl: fetchImpl,
    });
    expect(fetchImpl.mock.calls[0][1].headers['User-Agent']).toBe(`commonly-mcp/${pkg.version}`);
  });

  it('answers the MCP initialize handshake with it', async () => {
    const child = spawn(process.execPath, [new URL('../src/index.js', import.meta.url).pathname], {
      env: { PATH: process.env.PATH, COMMONLY_API_URL: 'https://x.example', COMMONLY_AGENT_TOKEN: 'cm_agent_test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const reply = await new Promise((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`no handshake reply; stdout: ${out}`)), 10000);
        child.stdout.on('data', (chunk) => {
          out += chunk;
          const line = out.split('\n').find((l) => l.includes('"id":1'));
          if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
        });
        child.on('error', reject);
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
        })}\n`);
      });
      expect(reply.result.serverInfo).toEqual({ name: pkg.name, version: pkg.version });
    } finally {
      child.kill();
    }
  });
});
