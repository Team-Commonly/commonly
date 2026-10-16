/**
 * host-sandbox-preflight.test.mjs
 *
 * A seat bootstrapped from the Connect page's env vars runs public, and its
 * sandbox resolves per host: Seatbelt on macOS, bubblewrap elsewhere. On a host
 * without that mechanism (native Windows, or Linux without bubblewrap) the
 * listener used to start, poll, and fail every turn. `agent run` now asks once,
 * before it saves a token or polls, and stops with directions.
 *
 * Covers the pure check, and the command wiring: the real `agent run` action,
 * built by registerAgent, with the platform reported as win32.
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { Command } from 'commander';

const homeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-host-sandbox-test-'));
const createClientMock = jest.fn();
let mockCliFound = true;

await jest.unstable_mockModule('os', () => {
  const actual = os;
  return {
    ...actual,
    default: { ...actual, homedir: () => homeTmpDir },
    homedir: () => homeTmpDir,
  };
});
await jest.unstable_mockModule('../src/lib/api.js', () => ({ createClient: createClientMock }));
await jest.unstable_mockModule('../src/lib/adapters/index.js', () => ({
  getAdapter: (name) => (['claude', 'codex', 'pi', 'opencode', 'stub'].includes(name)
    ? { name, detect: async () => mockCliFound }
    : null),
  listAdapterNames: () => ['claude', 'codex', 'pi', 'opencode', 'stub'],
}));

const { hostSandboxRefusal } = await import('../src/lib/sandbox/host-check.js');
const { registerAgent, saveAgentToken } = await import('../src/commands/agent.js');
const { defaultSeatSandbox } = await import('../src/lib/default-environment.js');

afterAll(() => fs.rmSync(homeTmpDir, { recursive: true, force: true }));

const available = () => ({ available: true });
const missing = (error) => () => ({ available: false, error });
const never = () => { throw new Error('no detector should run on this host'); };

describe('hostSandboxRefusal', () => {
  // What a Connect-page seat is saved with: the daemon's default, no mode.
  const connectPage = { sandbox: defaultSeatSandbox() };

  test('the Connect page seat on native Windows is refused with three ways forward', () => {
    const message = hostSandboxRefusal({
      environment: connectPage, adapterName: 'claude', platform: 'win32', detectBwrap: never, detectSeatbelt: never,
    });
    expect(message).toMatch(/runs a connected Claude Code inside a sandbox, and has no sandbox for Windows yet/);
    expect(message).toMatch(/cannot listen for @mentions from native Windows/);
    expect(message).toContain('WSL 2 (Ubuntu)');
    expect(message).toContain('sudo apt install bubblewrap');
    expect(message).toContain('PowerShell `claude mcp add` command');
    expect(message).toContain('"Run it here"');
    // The old advice turned the sandbox off, which a public seat refuses anyway.
    expect(message).not.toMatch(/sandbox\.mode: none/);
  });

  test('on macOS the seat runs when Seatbelt is there, and is refused with the reason when it is not', () => {
    const args = { environment: connectPage, adapterName: 'claude', platform: 'darwin', detectBwrap: never };
    expect(hostSandboxRefusal({ ...args, detectSeatbelt: available })).toBeNull();
    expect(hostSandboxRefusal({ ...args, detectSeatbelt: missing('sandbox-exec preflight failed: exit 1') }))
      .toBe('This seat runs in a macOS Seatbelt sandbox (sandbox.mode=workspace), which is not available here. '
        + 'sandbox-exec preflight failed: exit 1');
  });

  test('on Linux, a missing bubblewrap stops the run with the install line', () => {
    const args = { environment: connectPage, adapterName: 'claude', platform: 'linux', detectSeatbelt: never };
    expect(hostSandboxRefusal({ ...args, detectBwrap: available })).toBeNull();
    expect(hostSandboxRefusal({ ...args, detectBwrap: missing('bwrap not found on PATH. Install bubblewrap: `apt install bubblewrap` (Debian/Ubuntu).') }))
      .toMatch(/^This seat runs in a bubblewrap sandbox, which is not available here\. bwrap not found on PATH\. Install bubblewrap/);
  });

  test('a legacy internal trust reads as public', () => {
    expect(hostSandboxRefusal({
      environment: { sandbox: { trust: 'internal' } }, adapterName: 'claude', platform: 'win32',
    })).toMatch(/no sandbox for Windows yet/);
  });

  test('OpenCode on Windows gets the same directions, without the Claude Code MCP line', () => {
    const message = hostSandboxRefusal({
      environment: connectPage, adapterName: 'opencode', platform: 'win32',
    });
    expect(message).toMatch(/runs a connected OpenCode inside a sandbox/);
    expect(message).not.toContain('claude mcp add');
  });

  test('adapters these mechanisms do not confine, and seats with no enforced mode, are left alone', () => {
    expect(hostSandboxRefusal({ environment: connectPage, adapterName: 'codex', platform: 'win32' })).toBeNull();
    expect(hostSandboxRefusal({ environment: { sandbox: { trust: 'public' } }, adapterName: 'pi', platform: 'win32' })).toBeNull();
    expect(hostSandboxRefusal({ environment: null, adapterName: 'claude', platform: 'win32' })).toBeNull();
    expect(hostSandboxRefusal({ environment: { sandbox: { mode: 'none' } }, adapterName: 'claude', platform: 'win32' })).toBeNull();
  });
});

describe('agent run on a host that cannot confine the seat', () => {
  const exitSentinel = new Error('process.exit called');
  const tokenPath = path.join(homeTmpDir, '.commonly', 'tokens', 'byo-win.json');
  let exitSpy;
  let errorSpy;
  let platform;

  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      exitSentinel.code = code;
      throw exitSentinel;
    });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    createClientMock.mockReset();
  });

  test('the env-token first run stops before saving a token or polling, and says what to do', async () => {
    const oldToken = process.env.COMMONLY_AGENT_TOKEN;
    const oldApiUrl = process.env.COMMONLY_API_URL;
    process.env.COMMONLY_AGENT_TOKEN = 'cm_agent_test';
    process.env.COMMONLY_API_URL = 'https://api.commonly.me';
    createClientMock
      .mockReturnValueOnce({
        get: jest.fn().mockResolvedValue({
          agentName: 'byo-win',
          instanceId: 'connect-page',
          installations: [{
            type: 'installation', podId: 'pod-1', instanceId: 'connect-page', status: 'active', runtimeAdapter: null,
          }],
        }),
      })
      // Anything past the preflight would make a second client: the binding
      // check or the poll loop. Either one reaching here fails the arm.
      .mockImplementation(() => { throw new Error('agent run went past the host check'); });

    try {
      const program = new Command();
      program.exitOverride();
      registerAgent(program);
      await expect(program.parseAsync(['agent', 'run', 'byo-win'], { from: 'user' })).rejects.toBe(exitSentinel);
    } finally {
      if (oldToken === undefined) delete process.env.COMMONLY_AGENT_TOKEN; else process.env.COMMONLY_AGENT_TOKEN = oldToken;
      if (oldApiUrl === undefined) delete process.env.COMMONLY_API_URL; else process.env.COMMONLY_API_URL = oldApiUrl;
    }

    expect(exitSentinel.code).toBe(1);
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(tokenPath)).toBe(false);
    const stderr = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(stderr).toContain('[byo-win] Commonly runs a connected Claude Code inside a sandbox, and has no sandbox for Windows yet');
    expect(stderr).toContain('sudo apt install bubblewrap');
  });

  // An npm-installed Claude Code is a .cmd shim Node cannot spawn, so on
  // Windows "no CLI found" usually means "installed, and not runnable here".
  test('on Windows, finding no CLI at all also prints the directions', async () => {
    mockCliFound = false;
    const oldToken = process.env.COMMONLY_AGENT_TOKEN;
    process.env.COMMONLY_AGENT_TOKEN = 'cm_agent_test';
    createClientMock.mockReturnValueOnce({
      get: jest.fn().mockResolvedValue({
        agentName: 'byo-win',
        installations: [{ type: 'installation', podId: 'pod-1', instanceId: 'default', status: 'active', runtimeAdapter: null }],
      }),
    });
    try {
      const program = new Command();
      program.exitOverride();
      registerAgent(program);
      await expect(program.parseAsync(['agent', 'run', 'byo-win'], { from: 'user' })).rejects.toBe(exitSentinel);
    } finally {
      mockCliFound = true;
      if (oldToken === undefined) delete process.env.COMMONLY_AGENT_TOKEN; else process.env.COMMONLY_AGENT_TOKEN = oldToken;
    }
    const stderr = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(stderr).toContain('No supported agent CLI found on PATH');
    expect(stderr).toContain('has no sandbox for Windows yet');
    expect(fs.existsSync(tokenPath)).toBe(false);
  });
});

describe('a saved seat from before the default sandbox', () => {
  test('starts with one line saying how to pick the default up', async () => {
    saveAgentToken('byo-old', {
      agentName: 'byo-old',
      podId: 'pod-1',
      instanceUrl: 'https://api.commonly.me',
      runtimeToken: 'cm_agent_test',
      adapter: 'claude',
      workspacePath: null,
      environment: { mcp: [{ name: 'commonly', command: ['npx', '-y', '@commonlyai/mcp@latest'] }] },
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    // Past the warning the run would poll; stop it at its first client.
    createClientMock.mockImplementation(() => { throw new Error('reached the poll loop'); });
    try {
      const program = new Command();
      program.exitOverride();
      registerAgent(program);
      await expect(program.parseAsync(['agent', 'run', 'byo-old'], { from: 'user' })).rejects.toThrow('reached the poll loop');
      const warned = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(warned).toContain("[byo-old] this agent's saved settings predate the default sandbox");
      expect(warned).toContain('commonly agent detach byo-old --force, then run a fresh command from the Connect page');
    } finally {
      warnSpy.mockRestore();
      console.log.mockRestore();
      createClientMock.mockReset();
    }
  });
});
