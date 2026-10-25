// @ts-nocheck
import fs from 'fs';
import path from 'path';
import {
  buildByoHandoffCommand,
  buildByoHandoffPayload,
  defaultByoHandoffName,
  availableByoHandoffName,
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
});

describe('availableByoHandoffName', () => {
  it('preserves an unused base and checks suffixed names at the length limit', async () => {
    expect(await availableByoHandoffName('sam-claude', async () => false)).toBe('sam-claude');
    const base = 'a'.repeat(40);
    const isTaken = jest.fn(async (name) => name === base || name === `${'a'.repeat(38)}-2`);
    expect(await availableByoHandoffName(base, isTaken)).toBe(`${'a'.repeat(38)}-3`);
    expect(isTaken).toHaveBeenCalledTimes(3);
  });

  it('bounds occupied-name lookups and fails rather than suggesting an occupied name', async () => {
    const isTaken = jest.fn(async () => true);
    await expect(availableByoHandoffName('sam-claude', isTaken)).rejects.toThrow('Supply a different name');
    expect(isTaken).toHaveBeenCalledTimes(100);
  });

  it('propagates lookup failure instead of treating it as availability', async () => {
    await expect(availableByoHandoffName('sam-claude', async () => { throw new Error('unavailable'); }))
      .rejects.toThrow('unavailable');
  });
});
