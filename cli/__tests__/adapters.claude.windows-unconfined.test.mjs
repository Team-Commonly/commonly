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
    env: {
      Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\ada',
      APPDATA: 'C:\\Users\\ada\\AppData\\Roaming',
      OPENROUTER_API_KEY: 'sk-or-secret',
      COMMONLY_LITELLM_KEY: 'vk-secret',
    },
    ...over,
  });
  return { run, calls };
};

const denied0 = (args) => args.slice(args.indexOf('--disallowedTools') + 1);

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

  test('the child keeps what Windows needs to run and find its login, under one Path key', async () => {
    const { run, calls } = turn({ hostUnconfined: true });
    await run;
    const childEnv = calls[0].opts.env;
    expect(childEnv.SystemRoot).toBe('C:\\Windows');
    expect(childEnv.USERPROFILE).toBe('C:\\Users\\ada');
    expect(childEnv.APPDATA).toBe('C:\\Users\\ada\\AppData\\Roaming');
    const pathKeys = Object.keys(childEnv).filter((k) => k.toUpperCase() === 'PATH');
    expect(pathKeys).toEqual(['Path']);
    expect(childEnv.Path).toContain('C:\\Windows\\System32');
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
  // #3504 (CodeRabbit): the no-jail seat is told what it really has, through
  // the same spawn that grants it, so the prompt and the policy can't drift.
  test('a workspace seat with --allow write is told it can edit but has no shell, and nothing about .git', async () => {
    const { run, calls } = turn({
      hostUnconfined: true,
      environment: { model: 'test-model', sandbox: { trust: 'workspace', allow: ['write'] } },
    });
    await run;
    const { args } = calls[0];
    const text = args[args.indexOf('--append-system-prompt') + 1] || '';
    expect(text).toContain('You can read and edit the files in your working folder. You cannot run shell commands.');
    expect(text).not.toContain('run shell commands there');
    expect(text).not.toContain('.git');
    expect(text).not.toContain('reach the network');
  });

  test('a workspace seat with --allow write gets edits but no shell, and PowerShell stays denied', async () => {
    const { run, calls } = turn({
      hostUnconfined: true,
      environment: { model: 'test-model', sandbox: { trust: 'workspace', allow: ['write'] } },
    });
    await run;
    const { args } = calls[0];
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
    expect(allowed).toEqual(expect.arrayContaining(['Read(./**)', 'Edit(./**)', 'Write(./**)']));
    // Scoped to the folder: no bare Edit or Write that could reach the user's profile.
    expect(allowed).not.toContain('Edit');
    expect(allowed).not.toContain('Write');
    expect(denied0(args)).not.toContain('Edit');
    expect(allowed).not.toContain('Bash');
    expect(allowed).not.toContain('PowerShell');
    const denied = args.slice(args.indexOf('--disallowedTools') + 1);
    expect(denied).toEqual(expect.arrayContaining(['Bash', 'PowerShell']));
  });

  // F118 at the policy-only call site, which hands the builder no trust on a
  // public seat. A workspace seat on the same path keeps its memory writes.
  const mcp = [{ name: 'commonly', transport: 'http', url: 'https://api.example.test/mcp' }];
  const PUBLIC_ONLY = ['commonly_self_install_into_pod', 'commonly_write_agent_memory',
    'commonly_save_my_memory', 'commonly_log_cycle', 'commonly_delete_message'];

  test('a public seat denies self-install and memory writes, and keeps the memory read', async () => {
    const { run, calls } = turn({
      hostUnconfined: true,
      environment: { model: 'test-model', sandbox: { trust: 'public' }, mcp },
    });
    await run;
    const denied = denied0(calls[0].args);
    for (const tool of PUBLIC_ONLY) expect(denied).toContain(`mcp__commonly__${tool}`);
    expect(denied).not.toContain('mcp__commonly__commonly_read_agent_memory');
  });

  test('a workspace seat keeps its memory writes and log_cycle', async () => {
    const { run, calls } = turn({
      hostUnconfined: true,
      environment: { model: 'test-model', sandbox: { trust: 'workspace' }, mcp },
    });
    await run;
    const denied = denied0(calls[0].args);
    expect(denied).toContain('mcp__commonly__commonly_self_install_into_pod');
    for (const tool of ['commonly_write_agent_memory', 'commonly_save_my_memory', 'commonly_log_cycle',
      'commonly_delete_message']) {
      expect(denied).not.toContain(`mcp__commonly__${tool}`);
    }
  });

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
