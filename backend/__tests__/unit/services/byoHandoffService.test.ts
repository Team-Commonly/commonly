// @ts-nocheck
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

  it('returns all selectable commands but limits OpenCode and dsh to verified macOS', () => {
    const payload = buildByoHandoffPayload({
      adapter: 'dsh',
      os: 'mac',
      podId: 'pod-1',
      agentName: 'My DSH',
    });
    if ('error' in payload) throw new Error(payload.error);

    expect(payload).toMatchObject({
      kind: 'byo-handoff',
      adapter: 'dsh',
      agentName: 'my-dsh',
      podId: 'pod-1',
      supportedOs: ['mac'],
    });
    expect(payload.commands.mac).toContain('commonly agent attach dsh');
    expect(payload.commands.linux).toContain('/home/you/agents/environment.json');
    expect(payload.commands.windows).toContain('C:\\Users\\you\\agents\\environment.json');
  });

  it('creates a safe default name from the account handle', () => {
    expect(defaultByoHandoffName('Sam Xu', 'claude')).toBe('sam-xu-claude');
    expect(defaultByoHandoffName(undefined, 'codex')).toBe('my-codex');
  });
});
