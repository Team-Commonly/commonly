// D245, the review of #3388 (B2): on native Windows the user's --unsandboxed
// skips the OS jail ONLY. The seat keeps its trust, so the public tool policy
// and the sanitized environment still apply: on a host with no OS isolation
// that policy is the whole boundary. The opt-in reaches the adapter as
// `hostUnconfined` on the spawn context; the environment never carries it.
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

import { currentJsShim, fakeFs } from './fixtures/windows-shims.cjs';

const spawnSyncMock = jest.fn();
await jest.unstable_mockModule('child_process', () => ({ spawnSync: spawnSyncMock, spawn: jest.fn() }));
const claude = (await import('../src/lib/adapters/claude.js')).default;

const NODEJS = 'C:\\Program Files\\nodejs';
const NODE = `${NODEJS}\\node.exe`;
const NPM = 'C:\\Users\\ada\\AppData\\Roaming\\npm';
const CLAUDE_JS = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
const windows = () => ({
  platform: 'win32',
  env: { Path: `C:\\Windows\\System32;${NODEJS};${NPM}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
  execPath: NODE,
  ...fakeFs({ [`${NPM}\\claude.cmd`]: currentJsShim('node_modules\\@anthropic-ai\\claude-code\\cli.js'), [CLAUDE_JS]: '', [NODE]: 'MZ' }),
});

const recorder = () => {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    setTimeout(() => { proc.stdout.emit('data', Buffer.from('ok')); proc.emit('close', 0); }, 0);
    return proc;
  };
  return { impl, calls };
};

const turn = (over = {}) => {
  const { impl, calls } = recorder();
  const run = claude.spawn('hello from a stranger', {
    environment: { model: 'test-model', sandbox: { trust: 'public' } },
    sessionId: null,
    _spawnImpl: impl,
    _commandResolution: windows(),
    _platform: 'win32',
    _home: 'C:\\Users\\ada',
    env: { PATH: 'x', OPENROUTER_API_KEY: 'sk-or-secret', COMMONLY_LITELLM_KEY: 'vk-secret' },
    ...over,
  });
  return { run, calls };
};

describe('claude on native Windows with the user\'s --unsandboxed', () => {
  test('keeps the public tool policy and skips only the jail', async () => {
    const { run, calls } = turn({ hostUnconfined: true });
    await run;
    expect(calls).toHaveLength(1);
    const { cmd, args, opts } = calls[0];
    expect(cmd).toBe(NODE);
    expect(args[0]).toBe(CLAUDE_JS);
    const at = (flag) => args[args.indexOf(flag) + 1];
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(at('--setting-sources')).toBe('');
    expect(at('--permission-mode')).toBe('dontAsk');
    expect(at('--allowedTools')).toBe('Read(./**)');
    expect(args).toContain('--disallowedTools');
    expect(opts.shell).toBeUndefined();
  });

  test('the secrets in the daemon environment do not reach the child', async () => {
    const { run, calls } = turn({ hostUnconfined: true });
    await run;
    const childEnv = calls[0].opts.env;
    expect(childEnv.OPENROUTER_API_KEY).toBeUndefined();
    expect(childEnv.COMMONLY_LITELLM_KEY).toBeUndefined();
  });

  test('the home denies are written in the POSIX form Claude Code matches on Windows', async () => {
    const { run, calls } = turn({ hostUnconfined: true });
    await run;
    const { args } = calls[0];
    expect(args).toContain('Read(//c/Users/ada/.commonly/**)');
    expect(args).toContain('Read(//c/Users/ada/.claude/**)');
    expect(args).toContain('Read(//c/Users/ada/.ssh/**)');
    expect(args.filter((a) => a.startsWith('Read(') && a.includes('\\'))).toEqual([]);
  });

  // The refusal names the host's own mechanism (Seatbelt on this test host, bwrap on Windows,
  // where host-check refuses earlier still); what matters is that nothing is spawned.
  test('without the opt-in the seat is still refused (no jail on Windows)', async () => {
    const { run, calls } = turn();
    await expect(run).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test('an environment that claims the opt-in is not the opt-in', async () => {
    const { run, calls } = turn({
      environment: { model: 'test-model', sandbox: { trust: 'public', hostUnconfined: true }, hostUnconfined: true },
    });
    await expect(run).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test('a truthy non-true value is not the opt-in', async () => {
    for (const hostUnconfined of ['true', 1, {}]) {
      const { run } = turn({ hostUnconfined });
      // eslint-disable-next-line no-await-in-loop
      await expect(run).rejects.toThrow();
    }
  });
});
