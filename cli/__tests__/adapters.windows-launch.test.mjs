// Claude and Codex adapters on native Windows (#2141), simulated: the
// resolver's platform, env and filesystem are injected through the
// `_commandResolution` test seam, and child_process is mocked, so nothing is
// launched. What is asserted is the argv each adapter hands to spawn: the
// shim's real target, no shell, and the prompt as one verbatim element.

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { readFileSync as realReadFileSync, writeFileSync } from 'fs';

import {
  currentExeShim, currentJsShim, fakeFs, NPM_NPX_CMD,
} from './fixtures/windows-shims.cjs';

const spawnSyncMock = jest.fn();
await jest.unstable_mockModule('child_process', () => ({
  spawnSync: spawnSyncMock,
  spawn: jest.fn(),
}));

const claude = (await import('../src/lib/adapters/claude.js')).default;
const codex = (await import('../src/lib/adapters/codex.js')).default;

const NODEJS = 'C:\\Program Files\\nodejs';
const NODE = `${NODEJS}\\node.exe`;
const NPM = 'C:\\Users\\ada\\AppData\\Roaming\\npm';
const CLAUDE_JS = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
const CODEX_EXE = `${NPM}\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe`;
const NPX_CLI = `${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`;

const WIN_FILES = {
  [`${NPM}\\claude.cmd`]: currentJsShim('node_modules\\@anthropic-ai\\claude-code\\cli.js'),
  [CLAUDE_JS]: '',
  [`${NPM}\\codex.cmd`]: currentExeShim('node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe'),
  [CODEX_EXE]: 'MZ',
  [`${NODEJS}\\npx.cmd`]: NPM_NPX_CMD,
  [NODE]: 'MZ',
  [NPX_CLI]: '',
};

const windows = () => ({
  platform: 'win32',
  env: { Path: `C:\\Windows\\System32;${NODEJS};${NPM}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
  execPath: NODE,
  ...fakeFs(WIN_FILES),
});

const INJECTION = 'summarize this & calc.exe | del /q C:\\* "quoted" %PATH% ^& ok';

const COMMONLY_MCP = () => ({
  name: 'commonly',
  transport: 'stdio',
  command: ['npx', '-y', '@commonlyai/mcp@latest'],
  env: {
    COMMONLY_API_URL: '${COMMONLY_API_URL}',
    COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}',
  },
});

const fakeChild = ({ stdout = '', onSpawn } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  setTimeout(() => {
    onSpawn?.();
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  }, 0);
  return proc;
};

// Records each spawn and, while the per-spawn files still exist, what the
// claude MCP config said and what codex's output file should contain.
const recorder = ({ stdout = '', codexOutput = null } = {}) => {
  const calls = [];
  const impl = (cmd, args, opts) => {
    const call = { cmd, args, opts };
    calls.push(call);
    const mcpAt = args.indexOf('--mcp-config');
    if (mcpAt !== -1) call.mcpConfig = JSON.parse(realReadFileSync(args[mcpAt + 1], 'utf8'));
    const oAt = args.indexOf('-o');
    return fakeChild({
      stdout,
      onSpawn: () => { if (oAt !== -1 && codexOutput !== null) writeFileSync(args[oAt + 1], codexOutput); },
    });
  };
  return { impl, calls };
};

beforeEach(() => spawnSyncMock.mockReset());

describe('claude adapter on Windows', () => {
  test('detect() runs `node cli.js --version` from the npm shim and reports the shim', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '2.5.1 (Claude Code)\n' });
    const res = await claude.detect({ _commandResolution: windows() });
    expect(res).toEqual({ path: `${NPM}\\claude.cmd`, version: '2.5.1' });
    const [cmd, args, opts] = spawnSyncMock.mock.calls[0];
    expect([cmd, args]).toEqual([NODE, [CLAUDE_JS, '--version']]);
    expect(opts.shell).toBeUndefined();
    // No `which` on Windows.
    expect(spawnSyncMock.mock.calls.map(([c]) => c)).not.toContain('which');
  });

  test('detect() is null with a logged reason when nothing resolves', async () => {
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const res = await claude.detect({ _commandResolution: { ...windows(), ...fakeFs({}) } });
      expect(res).toBeNull();
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(write.mock.calls.join('')).toMatch(/claude adapter: claude was not found on PATH/);
    } finally {
      write.mockRestore();
    }
  });

  test('spawn() launches node + cli.js, no shell, prompt verbatim as one argv element', async () => {
    const { impl, calls } = recorder({ stdout: 'ok' });
    await claude.spawn(INJECTION, {
      environment: { model: 'test-model' }, sessionId: null, _spawnImpl: impl,
      _commandResolution: windows(),
    });
    expect(calls).toHaveLength(1);
    const { cmd, args, opts } = calls[0];
    expect(cmd).toBe(NODE);
    expect(args[0]).toBe(CLAUDE_JS);
    expect(args[1]).toBe('-p');
    expect(args.filter((a) => a.includes('& calc.exe'))).toHaveLength(1);
    expect(args[2]).toContain(INJECTION);
    expect(opts.shell).toBeUndefined();
  });

  test('the default commonly MCP server renders as node + npx-cli.js on win32', async () => {
    const { impl, calls } = recorder({ stdout: 'ok' });
    await claude.spawn('hi', {
      environment: { model: 'test-model', mcp: [COMMONLY_MCP()] },
      sessionId: null, _spawnImpl: impl, runtimeToken: 'cm_agent_test', instanceUrl: 'https://api.example.test',
      _commandResolution: windows(),
    });
    const entry = calls[0].mcpConfig.mcpServers.commonly;
    expect(entry.command).toBe(NODE);
    expect(entry.args).toEqual([NPX_CLI, '-y', '@commonlyai/mcp@latest']);
  });

  test('posix render of the same server is unchanged (npx, -y, the spec)', async () => {
    const { impl, calls } = recorder({ stdout: 'ok' });
    await claude.spawn('hi', {
      environment: { model: 'test-model', mcp: [COMMONLY_MCP()] },
      sessionId: null, _spawnImpl: impl, runtimeToken: 'cm_agent_test', instanceUrl: 'https://api.example.test',
      _commandResolution: { platform: 'linux' },
    });
    expect(calls[0].cmd).toBe('claude');
    const entry = calls[0].mcpConfig.mcpServers.commonly;
    expect(entry.command).toBe('npx');
    expect(entry.args).toEqual(['-y', '@commonlyai/mcp@latest']);
  });

  test('an unresolvable MCP command is left as declared, with one warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { impl, calls } = recorder({ stdout: 'ok' });
      const files = { ...WIN_FILES };
      delete files[`${NODEJS}\\npx.cmd`];
      await claude.spawn('hi', {
        environment: { model: 'test-model', mcp: [COMMONLY_MCP()] },
        sessionId: null, _spawnImpl: impl, runtimeToken: 'cm_agent_test', instanceUrl: 'https://api.example.test',
        _commandResolution: { ...windows(), ...fakeFs(files) },
      });
      expect(calls[0].mcpConfig.mcpServers.commonly.command).toBe('npx');
      const lines = warn.mock.calls.map(([line]) => line).filter((line) => /MCP server commonly/.test(line));
      expect(lines).toEqual([expect.stringMatching(/^\[claude\] MCP server commonly: left as declared, npx was not found/)]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('codex adapter on Windows', () => {
  test('detect() runs the vendored codex.exe the npm shim points at', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'codex-cli 0.125.0\n' });
    const res = await codex.detect({ _commandResolution: windows() });
    expect(res).toEqual({ path: `${NPM}\\codex.cmd`, version: '0.125.0' });
    expect(spawnSyncMock.mock.calls[0].slice(0, 2)).toEqual([CODEX_EXE, ['--version']]);
    expect(spawnSyncMock.mock.calls.map(([c]) => c)).not.toContain('which');
  });

  test('spawn() launches codex.exe directly, no shell, prompt verbatim as the last element', async () => {
    const { impl, calls } = recorder({ stdout: '{"type":"turn.completed"}\n', codexOutput: 'ok' });
    await codex.spawn(INJECTION, {
      environment: { model: 'test-model' }, sessionId: null, _spawnImpl: impl,
      _commandResolution: windows(),
    });
    const { cmd, args, opts } = calls[0];
    expect(cmd).toBe(CODEX_EXE);
    expect(args[0]).toBe('exec');
    expect(args[args.length - 1]).toContain(INJECTION);
    expect(args.filter((a) => a.includes('& calc.exe'))).toHaveLength(1);
    expect(opts.shell).toBeUndefined();
  });

  test('a JS codex shim puts node + codex.js ahead of `exec`', async () => {
    const codexJs = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const { impl, calls } = recorder({ stdout: '{"type":"turn.completed"}\n', codexOutput: 'ok' });
    await codex.spawn('hi', {
      environment: { model: 'test-model' }, sessionId: null, _spawnImpl: impl,
      _commandResolution: {
        ...windows(),
        ...fakeFs({ ...WIN_FILES, [`${NPM}\\codex.cmd`]: currentJsShim('node_modules\\@openai\\codex\\bin\\codex.js'), [codexJs]: '' }),
      },
    });
    expect(calls[0].cmd).toBe(NODE);
    expect(calls[0].args.slice(0, 2)).toEqual([codexJs, 'exec']);
  });

  const mcpFlags = (args) => args.map((a, i) => (a === '-c' ? args[i + 1] : null)).filter(Boolean);

  test('the default commonly MCP server renders as node + npx-cli.js on win32', async () => {
    const { impl, calls } = recorder({ stdout: '{"type":"turn.completed"}\n', codexOutput: 'ok' });
    await codex.spawn('hi', {
      environment: { model: 'test-model', mcp: [COMMONLY_MCP()] },
      sessionId: null, _spawnImpl: impl, runtimeToken: 'cm_agent_test', instanceUrl: 'https://api.example.test',
      _commandResolution: windows(),
    });
    const flags = mcpFlags(calls[0].args);
    expect(flags).toContain(`mcp_servers.commonly.command=${JSON.stringify(NODE)}`);
    expect(flags).toContain(`mcp_servers.commonly.args=${JSON.stringify([NPX_CLI, '-y', '@commonlyai/mcp@latest'])}`);
  });

  test('posix render of the same server is unchanged', async () => {
    const { impl, calls } = recorder({ stdout: '{"type":"turn.completed"}\n', codexOutput: 'ok' });
    await codex.spawn('hi', {
      environment: { model: 'test-model', mcp: [COMMONLY_MCP()] },
      sessionId: null, _spawnImpl: impl, runtimeToken: 'cm_agent_test', instanceUrl: 'https://api.example.test',
      _commandResolution: { platform: 'linux' },
    });
    expect(calls[0].cmd).toBe('codex');
    const flags = mcpFlags(calls[0].args);
    expect(flags).toContain('mcp_servers.commonly.command="npx"');
    expect(flags).toContain(`mcp_servers.commonly.args=${JSON.stringify(['-y', '@commonlyai/mcp@latest'])}`);
  });
});
