import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-'));
jest.unstable_mockModule('os', () => ({ ...os, default: { ...os, homedir: () => tmp }, homedir: () => tmp }));

const { buildMcpConfig } = await import('../src/commands/mcp.js');

const TOKEN = 'cm_agent_secretvalue123';
const tokensDir = path.join(tmp, '.commonly', 'tokens');

const seed = (name, extra = {}) => {
  fs.mkdirSync(tokensDir, { recursive: true });
  fs.writeFileSync(path.join(tokensDir, `${name}.json`),
    JSON.stringify({ runtimeToken: TOKEN, instanceUrl: 'https://api.example.test', podId: 'p1', ...extra }));
};

beforeEach(() => fs.rmSync(path.join(tmp, '.commonly'), { recursive: true, force: true }));

describe('commonly mcp config', () => {
  it('points at a 0600 token file and never prints the token', () => {
    seed('lead');
    const config = buildMcpConfig({});
    const env = config.mcpServers.commonly.env;
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(env.COMMONLY_API_URL).toBe('https://api.example.test');
    expect(fs.readFileSync(env.COMMONLY_TOKEN_FILE, 'utf8').trim()).toBe(TOKEN);
    expect(fs.statSync(env.COMMONLY_TOKEN_FILE).mode & 0o777).toBe(0o600);
  });

  it('keeps 0600 when the file already exists with a looser mode', () => {
    seed('lead');
    const first = buildMcpConfig({}).mcpServers.commonly.env.COMMONLY_TOKEN_FILE;
    fs.chmodSync(first, 0o644);
    buildMcpConfig({ agent: 'lead' });
    expect(fs.statSync(first).mode & 0o777).toBe(0o600);
  });

  it('names the attach command when no agent exists', () => {
    expect(() => buildMcpConfig({})).toThrow(/commonly agent attach/);
  });

  it('asks for --agent when several are attached', () => {
    seed('a'); seed('b');
    expect(() => buildMcpConfig({})).toThrow(/--agent/);
    expect(buildMcpConfig({ agent: 'b' }).mcpServers.commonly.env.COMMONLY_TOKEN_FILE).toMatch(/b\.token$/);
  });

  it('rejects a path-like agent name', () => {
    expect(() => buildMcpConfig({ agent: '../x' })).toThrow(/Invalid agent name/);
  });
});
