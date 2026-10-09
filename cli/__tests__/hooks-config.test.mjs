import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  MAX_HOOK_TIMEOUT_MS,
  buildHookCommand,
  mergeHooksConfig,
  writeHooksConfig,
  forwardHookEvent,
  resolveHookToken,
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
    expect(buildHookCommand({ agentName: 'nova', timeoutMs: 6000 })).toContain(`--timeout ${MAX_HOOK_TIMEOUT_MS}`);
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
    expect(payload.paths).toEqual(['src/a.ts']);
    expect(JSON.stringify(payload)).not.toContain('never send this');
  });

  test('drops parent traversal and paths outside the caller checkout', () => {
    const payload = sanitizeHookPayload({
      hook_event_name: 'PreToolUse',
      tool_input: { file_path: '../outside.txt', paths: ['/tmp/outside.txt'] },
    }, { cwd: process.cwd() });
    expect(payload.paths).toBeUndefined();
  });
});

describe('the hook credential follows the runtime it runs inside (TASK-083)', () => {
  test('the launcher file wins over the value variable', () => {
    // A hook is a child of the seat's runtime, and that is the environment
    // TASK-083 emptied of the token — so a hook still reading only the value
    // would find nothing and fail open, silently unenforcing the tool policy.
    const token = resolveHookToken({
      env: { COMMONLY_TOKEN_FILE: '/run/seat/token', COMMONLY_AGENT_TOKEN: 'cm_agent_stale' },
      readTokenFile: (path) => (path === '/run/seat/token' ? 'cm_agent_live\n' : ''),
    });
    expect(token).toBe('cm_agent_live');
  });

  test('an unreadable file falls back to the value rather than breaking the hook', () => {
    const token = resolveHookToken({
      env: { COMMONLY_TOKEN_FILE: '/gone/token', COMMONLY_AGENT_TOKEN: 'cm_agent_env' },
      readTokenFile: () => { throw new Error('ENOENT'); },
    });
    expect(token).toBe('cm_agent_env');
  });

  test('an empty file falls back too, and a blank declaration is not consulted at all', () => {
    expect(resolveHookToken({
      env: { COMMONLY_TOKEN_FILE: '/empty', COMMONLY_AGENT_TOKEN: 'cm_agent_env' },
      readTokenFile: () => '   \n',
    })).toBe('cm_agent_env');
    let consulted = 0;
    expect(resolveHookToken({
      env: { COMMONLY_TOKEN_FILE: '   ', COMMONLY_AGENT_TOKEN: 'cm_agent_env' },
      readTokenFile: () => { consulted += 1; return 'x'; },
    })).toBe('cm_agent_env');
    expect(consulted).toBe(0);
  });

  test('a seat that declares nothing keeps the pre-existing behaviour', () => {
    expect(resolveHookToken({ env: { COMMONLY_AGENT_TOKEN: 'cm_agent_only' } })).toBe('cm_agent_only');
  });
});
