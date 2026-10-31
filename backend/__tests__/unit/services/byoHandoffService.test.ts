// @ts-nocheck
import fs from 'fs';
import path from 'path';
import {
  buildByoHandoffCommand,
  buildByoHandoffPayload,
  defaultByoHandoffName,
} from '../../../services/byoHandoffService';

describe('byoHandoffService', () => {
  it('builds the exact OpenCode attach flow for each OS without a token', () => {
    const command = buildByoHandoffCommand({
      adapter: 'opencode',
      os: 'mac',
      podId: '507f1f77bcf86cd799439011',
      agentName: 'sam-opencode',
    });

    expect(command).toBe([
      'npm i -g @commonlyai/cli@latest opencode-ai',
      'commonly login',
      'commonly agent attach opencode --pod 507f1f77bcf86cd799439011 '
        + '--name sam-opencode --env /Users/you/agents/environment.json',
      'commonly agent run sam-opencode',
    ].join('\n'));
    expect(command).not.toMatch(/token|cm_agent|COMMONLY_/i);
  });

  it('normalizes unsupported OS choices and emits only verified dsh commands', () => {
    const payload = buildByoHandoffPayload({
      adapter: 'dsh',
      os: 'windows',
      podId: 'pod-1',
      agentName: 'My DSH',
    });
    if ('error' in payload) throw new Error(payload.error);

    expect(payload).toMatchObject({
      kind: 'byo-handoff',
      adapter: 'dsh',
      agentName: 'my-dsh',
      podId: 'pod-1',
      os: 'mac',
      supportedOs: ['mac'],
    });
    expect(payload.commands.mac).toContain('commonly agent attach dsh');
    expect(payload.commands.linux).toBeUndefined();
    expect(payload.commands.windows).toBeUndefined();
  });

  it('keeps the dsh install command aligned with its smoke-tested adapter version', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../../cli/src/lib/adapters/dsh.js'),
      'utf8',
    );
    const match = source.match(/TESTED_DSH_VERSIONS = Object\.freeze\(\['([^']+)'\]\)/);
    expect(match?.[1]).toBeTruthy();

    const command = buildByoHandoffCommand({
      adapter: 'dsh',
      os: 'mac',
      podId: 'pod-1',
      agentName: 'my-dsh',
    });
    expect(command).toContain(`@deepseek-ai/dsh@${match?.[1]}`);
  });

  it('carries the server-owned source identity into every OS command', () => {
    const payload = buildByoHandoffPayload({ adapter: 'codex', os: 'linux', podId: 'pod-1',
      agentName: 'new-local', memoryFrom: 'scout', memoryInstance: 'hosted-123' });
    if ('error' in payload) throw new Error(payload.error);
    for (const command of Object.values(payload.commands)) {
      expect(command).toContain('--memory-from scout --memory-instance hosted-123');
    }
    expect(buildByoHandoffPayload({ adapter: 'codex', os: 'mac', podId: 'pod-1',
      agentName: 'new-local', memoryFrom: 'scout; echo secret' })).toEqual({ error: 'invalid source memory identity' });
    expect(buildByoHandoffPayload({ adapter: 'codex', os: 'mac', podId: 'pod-1',
      agentName: 'new-local', memoryFrom: 'scout', memoryInstance: 'default; echo secret' }))
      .toEqual({ error: 'invalid source memory identity' });
  });

  it('creates a safe default name from the account handle', () => {
    expect(defaultByoHandoffName('Sam Xu', 'claude')).toBe('sam-xu-claude');
    expect(defaultByoHandoffName(undefined, 'codex')).toBe('my-codex');
  });

  describe('login line', () => {
    const ENV_KEYS = ['PUBLIC_API_URL', 'BACKEND_URL'];
    let saved;

    beforeEach(() => {
      saved = ENV_KEYS.map((key) => [key, process.env[key]]);
      ENV_KEYS.forEach((key) => { delete process.env[key]; });
    });

    afterEach(() => {
      saved.forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    });

    const loginLineFor = (os) => {
      const payload = buildByoHandoffPayload({
        adapter: 'codex', os, podId: 'pod-1', agentName: 'my-codex',
      });
      if ('error' in payload) throw new Error(payload.error);
      return payload.commands[os].split('\n')[1];
    };

    it('stays a bare login when the server has no public origin configured', () => {
      expect(loginLineFor('linux')).toBe('commonly login');
    });

    it('names the server origin on every OS when BACKEND_URL is set', () => {
      process.env.BACKEND_URL = 'http://localhost:5000';
      for (const os of ['mac', 'linux', 'windows']) {
        expect(loginLineFor(os)).toBe('commonly login --instance http://localhost:5000');
      }
    });

    it('prefers PUBLIC_API_URL and reduces it to the bare origin', () => {
      process.env.BACKEND_URL = 'http://backend.internal:5000';
      process.env.PUBLIC_API_URL = 'https://api.commonly.me/api?token=x#frag';
      expect(loginLineFor('mac')).toBe('commonly login --instance https://api.commonly.me');
    });

    it('drops a configured value that is not a plain http(s) origin', () => {
      for (const unsafe of ['file:///etc/passwd', 'ftp://api.commonly.me', 'http://$(id)', 'not a url']) {
        process.env.PUBLIC_API_URL = unsafe;
        expect(loginLineFor('mac')).toBe('commonly login');
      }
    });
  });
});
