import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-'));
jest.unstable_mockModule('os', () => ({ ...os, default: { ...os, homedir: () => tmp }, homedir: () => tmp }));

const { buildMcpConfig } = await import('../src/commands/mcp.js');
const { performDetach, saveAgentToken } = await import('../src/commands/agent.js');

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
    if (process.platform !== 'win32') expect(fs.statSync(env.COMMONLY_TOKEN_FILE).mode & 0o777).toBe(0o600);
  });

  it('keeps 0600 when the file already exists with a looser mode', () => {
    seed('lead');
    const first = buildMcpConfig({}).mcpServers.commonly.env.COMMONLY_TOKEN_FILE;
    fs.chmodSync(first, 0o644);
    buildMcpConfig({ agent: 'lead' });
    if (process.platform !== 'win32') expect(fs.statSync(first).mode & 0o777).toBe(0o600);
  });

  it('does not write through a symlink at the token path', () => {
    seed('lead');
    const dir = path.join(tmp, '.commonly', 'mcp');
    fs.mkdirSync(dir, { recursive: true });
    const victim = path.join(tmp, 'victim');
    fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, path.join(dir, 'lead.token'));
    buildMcpConfig({ agent: 'lead' });
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
  });

  it('tightens a pre-existing loose mcp dir and refuses a non-agent token', () => {
    seed('lead');
    const dir = path.join(tmp, '.commonly', 'mcp');
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    buildMcpConfig({ agent: 'lead' });
    if (process.platform !== 'win32') expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    seed('user', { runtimeToken: 'eyJuser.jwt' });
    expect(() => buildMcpConfig({ agent: 'user' })).toThrow(/cm_agent_/);
  });

  it('detach (even --force, local only) deletes the MCP copy', async () => {
    seed('lead');
    const copy = buildMcpConfig({}).mcpServers.commonly.env.COMMONLY_TOKEN_FILE;
    await performDetach({ agentName: 'lead', skipBackend: true });
    expect(fs.existsSync(copy)).toBe(false);
  });

  it('reattach (saveAgentToken) rewrites an existing MCP copy, and creates none otherwise', () => {
    seed('lead');
    saveAgentToken('lead', { runtimeToken: 'cm_agent_before', instanceUrl: 'https://api.example.test' });
    expect(fs.existsSync(path.join(tmp, '.commonly', 'mcp', 'lead.token'))).toBe(false);
    const copy = buildMcpConfig({}).mcpServers.commonly.env.COMMONLY_TOKEN_FILE;
    saveAgentToken('lead', { runtimeToken: 'cm_agent_after', instanceUrl: 'https://api.example.test' });
    expect(fs.readFileSync(copy, 'utf8').trim()).toBe('cm_agent_after');
    if (process.platform !== 'win32') expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
  });

  it('a traversal name cannot make remove or refresh touch anything, and does not block detach', async () => {
    const outside = path.join(tmp, '.commonly', 'x.token');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 'keep');
    saveAgentToken('../x', { runtimeToken: 'cm_agent_t', instanceUrl: 'u' });
    await performDetach({ agentName: '../x', skipBackend: true });
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
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
