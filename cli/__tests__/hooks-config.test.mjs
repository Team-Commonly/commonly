import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  buildHookCommand,
  mergeHooksConfig,
  writeHooksConfig,
  forwardHookEvent,
  sanitizeHookPayload,
} from '../src/lib/hooks-config.js';

describe('hooks config writer', () => {
  test('adds all hook events without putting a bearer in settings', () => {
    const config = mergeHooksConfig({ permissions: { allow: ['Read'] } }, { agentName: 'nova' });
    expect(config.permissions).toEqual({ allow: ['Read'] });
    expect(Object.keys(config.hooks)).toEqual(expect.arrayContaining([
      'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop',
    ]));
    expect(JSON.stringify(config)).not.toContain('cm_agent_');
    expect(buildHookCommand({ agentName: 'nova' })).toContain(`--timeout ${DEFAULT_HOOK_TIMEOUT_MS}`);
  });

  test('preserves unrelated hooks and replaces only this agent entry', () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit' }] }],
      },
      model: 'sonnet',
    };
    const once = mergeHooksConfig(existing, { agentName: 'nova' });
    const twice = mergeHooksConfig(once, { agentName: 'nova' });
    expect(twice.model).toBe('sonnet');
    expect(twice.hooks.PreToolUse).toHaveLength(2);
    expect(twice.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
  });

  test('writes project settings with restrictive permissions', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'commonly-hooks-'));
    const filePath = path.join(temp, '.claude', 'settings.local.json');
    writeHooksConfig({ filePath, agentName: 'nova' });
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(parsed.hooks.PreToolUse).toBeDefined();
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  test('fails open for a PreToolUse transport error', async () => {
    const stdout = [];
    let exitCode;
    await forwardHookEvent({
      endpoint: 'https://example.invalid/hook',
      token: 'cm_agent_test',
      input: JSON.stringify({ hook_event_name: 'PreToolUse', eventId: 'e1' }),
      fetchImpl: async () => { throw new Error('offline'); },
      stdout: (value) => stdout.push(value),
      stderr: () => {},
      exit: (code) => { exitCode = code; },
    });
    expect(stdout).toHaveLength(0);
    expect(exitCode).toBeUndefined();
  });

  test('sends only tool name, args digest, and resolved paths', () => {
    const payload = sanitizeHookPayload({
      hook_event_name: 'PreToolUse',
      event_id: 'e1',
      tool_name: 'Write',
      tool_input: { file_path: 'src/a.ts', content: 'never send this' },
    }, { cwd: process.cwd() });
    expect(payload).toEqual(expect.objectContaining({ event: 'PreToolUse', eventId: 'e1', tool: 'Write' }));
    expect(payload.argsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(payload)).not.toContain('never send this');
  });
});
