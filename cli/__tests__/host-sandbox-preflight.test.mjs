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
  listPublicAdapterNames: () => ['claude', 'codex', 'pi', 'opencode'],
}));

const { hostSandboxRefusal, windowsSandboxMessage } = await import('../src/lib/sandbox/host-check.js');
const { registerAgent, saveAgentToken } = await import('../src/commands/agent.js');
const { defaultSeatSandbox } = await import('../src/lib/default-environment.js');

afterAll(() => fs.rmSync(homeTmpDir, { recursive: true, force: true }));

const available = () => ({ available: true });
const missing = (error) => () => ({ available: false, error });
const never = () => { throw new Error('no detector should run on this host'); };

describe('hostSandboxRefusal', () => {
  // What a Connect-page seat is saved with: the daemon's default, no mode.
  const connectPage = { sandbox: defaultSeatSandbox() };

  test('the Connect page seat on native Windows is refused with the two ways forward', () => {
    const message = hostSandboxRefusal({
      environment: connectPage, adapterName: 'claude', platform: 'win32', detectBwrap: never, detectSeatbelt: never,
    });
    expect(message).toMatch(/runs a connected Claude Code inside a sandbox, and has no sandbox for Windows yet/);
    expect(message).toMatch(/cannot listen for @mentions from native Windows/);
    // WSL runs the Linux sandbox, which carries Claude Code since F96.
    expect(message).toContain('WSL 2 (Ubuntu): install Node and Claude Code inside WSL');
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

  // F96: a public Claude Code seat on Linux runs in the jail the workspace
  // tier built (#2784), so it is checked like any other bwrap seat: it runs
  // where bubblewrap does, and stops with the install line where it does not.
  test('a public Claude Code seat on Linux (WSL included) runs where bubblewrap does', () => {
    for (const sandbox of [{ mode: 'bwrap' }, { trust: 'public', mode: 'bwrap' }, { trust: 'internal' }]) {
      const args = { environment: { sandbox }, adapterName: 'claude', platform: 'linux', detectSeatbelt: never };
      expect(hostSandboxRefusal({ ...args, detectBwrap: available })).toBeNull();
      expect(hostSandboxRefusal({ ...args, detectBwrap: missing('bwrap not found on PATH. Install bubblewrap: `apt install bubblewrap` (Debian/Ubuntu).') }))
        .toMatch(/^This seat runs in a bubblewrap sandbox, which is not available here\. bwrap not found on PATH/);
    }
    expect(hostSandboxRefusal({
      environment: connectPage, adapterName: 'claude', platform: 'linux', detectBwrap: available, detectSeatbelt: never,
    })).toBeNull();
  });

  test('on Linux, a missing bubblewrap stops an OpenCode seat with the install line', () => {
    const args = { environment: connectPage, adapterName: 'opencode', platform: 'linux', detectSeatbelt: never };
    expect(hostSandboxRefusal({ ...args, detectBwrap: available })).toBeNull();
    expect(hostSandboxRefusal({ ...args, detectBwrap: missing('bwrap not found on PATH. Install bubblewrap: `apt install bubblewrap` (Debian/Ubuntu).') }))
      .toMatch(/^This seat runs in a bubblewrap sandbox, which is not available here\. bwrap not found on PATH\. Install bubblewrap/);
  });

  // TASK-294: a workspace seat is confined by the same host mechanism as a
  // public one, so a host that cannot confine it stops the run at start
  // rather than at the first turn.
  test('a workspace trust is checked against the host the same way as a public one', () => {
    const workspace = { sandbox: { trust: 'workspace' } };
    const args = { environment: workspace, adapterName: 'claude' };
    expect(hostSandboxRefusal({ ...args, platform: 'win32', detectBwrap: never, detectSeatbelt: never }))
      .toMatch(/no sandbox for Windows yet/);
    expect(hostSandboxRefusal({ ...args, platform: 'linux', detectBwrap: available, detectSeatbelt: never }))
      .toBeNull();
    expect(hostSandboxRefusal({ ...args, platform: 'darwin', detectBwrap: never, detectSeatbelt: available })).toBeNull();
    expect(hostSandboxRefusal({
      ...args, platform: 'darwin', detectBwrap: never, detectSeatbelt: missing('sandbox-exec preflight failed: exit 1'),
    })).toMatch(/^This seat runs in a macOS Seatbelt sandbox \(sandbox\.mode=workspace\)/);
  });

  // TASK-027: the bubblewrap probe is the gate for a workspace Claude seat on
  // Linux. Every way it can fail is a refusal, never a run without the jail.
  test('a workspace Claude seat on Linux runs only when bubblewrap can start a namespace', () => {
    const args = { environment: { sandbox: { trust: 'workspace', allow: ['write'] } }, adapterName: 'claude', platform: 'linux', detectSeatbelt: never };
    expect(hostSandboxRefusal({ ...args, detectBwrap: available })).toBeNull();
    expect(hostSandboxRefusal({ ...args, detectBwrap: missing('bwrap not found on PATH. Install bubblewrap: `sudo apt install bubblewrap` (Debian/Ubuntu, WSL).') }))
      .toMatch(/^This seat runs in a bubblewrap sandbox, which is not available here\. bwrap not found on PATH/);
    expect(hostSandboxRefusal({ ...args, detectBwrap: missing('bubblewrap is installed but cannot start a sandbox on this machine (setting up uid map: Permission denied).') }))
      .toMatch(/cannot start a sandbox on this machine \(setting up uid map: Permission denied\)/);
    expect(hostSandboxRefusal({ ...args, detectBwrap: missing('bwrap detection failed: spawnSync bwrap EACCES') }))
      .toMatch(/not available here\. bwrap detection failed/);
  });

  // Ubuntu 24.04 as it comes: bubblewrap installed, the namespace refused.
  describe('a host that refuses bubblewrap a sandbox', () => {
    const refused = (apparmorRestricted) => () => ({
      available: false,
      namespaceRefused: true,
      reason: 'bwrap: setting up uid map: Permission denied',
      apparmorRestricted,
      error: 'bubblewrap is installed but cannot start a sandbox on this machine',
    });
    const seat = (adapterName, detectBwrap) => hostSandboxRefusal({
      environment: { sandbox: { trust: 'public' } }, adapterName, platform: 'linux', detectBwrap, detectSeatbelt: never,
    });
    const ROUTE = 'choose "Run it here"';
    const PROFILE = 'sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict';

    test('Claude Code and Codex both stop at start, in plain words', () => {
      for (const [adapter, label] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
        const message = seat(adapter, refused(true));
        expect(message).toMatch(new RegExp(`^A connected ${label} runs inside a bubblewrap sandbox`));
        expect(message).toContain('uid map: Permission denied');
        expect(message).not.toMatch(/\bseat\b/i);
      }
    });

    test('the routes that change nothing here come first, and the profile is last and optional', () => {
      for (const adapter of ['claude', 'codex']) {
        const message = seat(adapter, refused(true));
        expect(message.indexOf(ROUTE)).toBeGreaterThan(-1);
        expect(message.indexOf(ROUTE)).toBeLessThan(message.indexOf('Optional,'));
        expect(message.indexOf('Optional,')).toBeLessThan(message.indexOf(PROFILE));
        expect(message).toMatch(/fresh\s+Ubuntu 24\.04 server image, not on every machine/);
        expect(message).toMatch(/needs sudo/);
        expect(message).toMatch(/Commonly never runs it for you/);
      }
      expect(seat('claude', refused(true)).indexOf('claude mcp add')).toBeLessThan(seat('claude', refused(true)).indexOf('Optional,'));
      expect(seat('codex', refused(true))).not.toContain('claude mcp add');
    });

    test('never the sysctl, and no profile but Ubuntu\'s', () => {
      for (const adapter of ['claude', 'codex', 'opencode']) {
        const message = seat(adapter, refused(true));
        expect(message).not.toMatch(/sysctl|apparmor_restrict_unprivileged_userns|aa-disable|userns,/);
      }
    });

    test('the profile is offered only where the AppArmor restriction is on, and only to adapters walked under it', () => {
      expect(seat('claude', refused(false))).not.toContain(PROFILE);
      expect(seat('claude', refused(false))).not.toContain('AppArmor');
      expect(seat('codex', refused(false))).toContain(ROUTE);
      expect(seat('opencode', refused(true))).not.toContain(PROFILE);
    });

    test('a Codex seat is checked only when public, and a missing bubblewrap stays Codex\'s to report', () => {
      expect(seat('codex', available)).toBeNull();
      expect(hostSandboxRefusal({
        environment: { sandbox: { trust: 'internal' } }, adapterName: 'codex', platform: 'linux', detectBwrap: refused(false),
      })).toMatch(/^A connected Codex runs inside a bubblewrap sandbox/);
      expect(seat('codex', () => ({ available: false, namespaceRefused: false, error: 'spawnSync bwrap ETIMEDOUT' }))).toBeNull();
      expect(seat('codex', missing('bwrap not found on PATH.'))).toBeNull();
      expect(hostSandboxRefusal({
        environment: { sandbox: { trust: 'workspace' } }, adapterName: 'codex', platform: 'linux', detectBwrap: never,
      })).toBeNull();
      expect(hostSandboxRefusal({
        environment: { sandbox: { trust: 'public' } }, adapterName: 'codex', platform: 'darwin', detectBwrap: never,
      })).toBeNull();
    });
  });

  test('a legacy internal trust reads as public', () => {
    expect(hostSandboxRefusal({
      environment: { sandbox: { trust: 'internal' } }, adapterName: 'claude', platform: 'win32',
    })).toMatch(/no sandbox for Windows yet/);
  });

  test('OpenCode on Windows is pointed at WSL 2, whose sandbox carries its binary, and not at the Claude Code MCP line', () => {
    const message = hostSandboxRefusal({
      environment: connectPage, adapterName: 'opencode', platform: 'win32',
    });
    expect(message).toMatch(/runs a connected OpenCode inside a sandbox/);
    expect(message).toContain('WSL 2 (Ubuntu)');
    expect(message).toContain('sudo apt install bubblewrap');
    expect(message).not.toContain('claude mcp add');
  });

  // Codex's unelevated Windows sandbox cannot enforce a public seat's split read
  // denies, and Codex has no tool policy beneath its permission profile, so an
  // unconfined Codex is a full shell driven by pod content. A public seat on
  // native Windows therefore always refuses, whatever opt-in it carries. Only a
  // seat with no public trust can pass, and only with hostUnconfined, which
  // `agent run` sets after confirming every pod private.
  test('a public Codex seat on native Windows always refuses, and the opt-in does not name the flag again', () => {
    for (const hostUnconfined of [false, true]) {
      const message = hostSandboxRefusal({
        environment: connectPage, adapterName: 'codex', platform: 'win32', hostUnconfined, optedIn: true,
      });
      expect(message).toContain('publicly readable or open to join');
      expect(message).toContain('WSL 2');
      expect(message).toContain('sudo apt install bubblewrap');
      expect(message).toContain('Run it here');
      expect(message).not.toContain('--unsandboxed');
    }
    expect(hostSandboxRefusal({
      environment: { sandbox: { trust: 'internal' } }, adapterName: 'codex', platform: 'win32', hostUnconfined: true,
    })).not.toBeNull();
  });

  test('a seat with no sandbox block that passed the flag and still fails is not told to add the flag', () => {
    const message = hostSandboxRefusal({ environment: null, adapterName: 'codex', platform: 'win32', optedIn: true });
    expect(message).toContain('publicly readable or open to join');
    expect(message).not.toContain('--unsandboxed');
  });

  test('without the opt-in, a Codex seat on native Windows refuses and names the flag, the pod it needs and what it costs', () => {
    for (const environment of [connectPage, null, { sandbox: { mode: 'none' } }]) {
      const message = hostSandboxRefusal({ environment, adapterName: 'codex', platform: 'win32' });
      expect(message).toContain('--unsandboxed');
      expect(message).toContain('invite-only');
      expect(message).toContain('anyone in the pod, people you invite later included, can direct it');
      expect(message).toContain('no connector grants');
      expect(message).toContain('WSL 2');
      expect(message).toContain('Run it here');
    }
    expect(windowsSandboxMessage('codex')).toBe(hostSandboxRefusal({ environment: null, adapterName: 'codex', platform: 'win32' }));
  });

  test('a Codex seat with no public trust passes on native Windows only with hostUnconfined', () => {
    for (const environment of [null, { model: 'gpt-5.1-codex' }, { sandbox: { mode: 'none' } }]) {
      expect(hostSandboxRefusal({ environment, adapterName: 'codex', platform: 'win32', hostUnconfined: true })).toBeNull();
      // A string or a truthy value is not the opt-in.
      expect(hostSandboxRefusal({ environment, adapterName: 'codex', platform: 'win32', hostUnconfined: 'true' })).not.toBeNull();
    }
  });

  // CodeRabbit on #3501: Codex refuses workspace trust on every platform
  // (refuseWorkspaceTrust, at attach and at spawn), in its own words. Pointing
  // such a seat to WSL would send it somewhere it fails again, so this check
  // leaves workspace to that refusal.
  test('a workspace Codex seat on Windows is left to the adapter\'s own workspace refusal, opt-in or not', () => {
    for (const hostUnconfined of [false, true]) {
      expect(hostSandboxRefusal({
        environment: { sandbox: { trust: 'workspace' } }, adapterName: 'codex', platform: 'win32', hostUnconfined,
      })).toBeNull();
    }
  });

  test('Codex on a Mac, or on a Linux host that starts a sandbox, is left alone', () => {
    expect(hostSandboxRefusal({ environment: connectPage, adapterName: 'codex', platform: 'darwin', detectBwrap: never })).toBeNull();
    expect(hostSandboxRefusal({ environment: connectPage, adapterName: 'codex', platform: 'linux', detectBwrap: available })).toBeNull();
    expect(hostSandboxRefusal({ environment: null, adapterName: 'codex', platform: 'linux', detectBwrap: never })).toBeNull();
  });

  test('adapters these mechanisms do not confine, and seats with no enforced mode, are left alone', () => {
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
    expect(stderr).toContain('PowerShell `claude mcp add` command');
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

describe('agent run: Codex on native Windows, by the opt-in only (F187)', () => {
  const privatePod = {
    type: 'installation', podId: 'pod-1', instanceId: 'default', status: 'active',
    publicRead: false, communityListed: false, joinPolicy: 'invite-only',
  };
  const exitSentinel = new Error('process.exit called');
  const recordPath = path.join(homeTmpDir, '.commonly', 'tokens', 'byo-codex-win.json');
  let platform; let exitSpy; let errorSpy; let warnSpy; let logSpy; let before;

  beforeEach(() => {
    saveAgentToken('byo-codex-win', {
      agentName: 'byo-codex-win',
      podId: 'pod-1',
      instanceUrl: 'https://api.commonly.me',
      runtimeToken: 'cm_agent_test',
      adapter: 'codex',
      workspacePath: null,
      environment: { model: 'gpt-5.1-codex', sandbox: { trust: 'public' } },
    });
    before = fs.readFileSync(recordPath);
    platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      exitSentinel.code = code;
      throw exitSentinel;
    });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    for (const spy of [exitSpy, errorSpy, warnSpy, logSpy]) spy.mockRestore();
    createClientMock.mockReset();
    fs.rmSync(recordPath, { force: true });
  });

  const run = async (args, rejection) => {
    const program = new Command();
    program.exitOverride();
    registerAgent(program);
    const running = program.parseAsync(['agent', 'run', 'byo-codex-win', ...args], { from: 'user' });
    if (rejection === exitSentinel) await expect(running).rejects.toBe(exitSentinel);
    else await expect(running).rejects.toThrow(rejection);
  };
  const printed = (spy) => spy.mock.calls.map((call) => call.join(' ')).join('\n');
  const hostReport = jest.fn().mockResolvedValue({ hostUnconfined: true });
  const podsRead = (result) => createClientMock.mockReturnValueOnce({ get: result, post: hostReport });

  test('no flag, private pods: refused, the pods are not read, and the line names the flag', async () => {
    await run([], exitSentinel);
    expect(exitSentinel.code).toBe(1);
    expect(createClientMock).not.toHaveBeenCalled();
    expect(printed(errorSpy)).toContain('--unsandboxed');
    expect(printed(warnSpy)).not.toContain('unsandboxed (opted in)');
  });

  test('the flag with every pod private: past the host check, with the notice, and the saved record untouched', async () => {
    podsRead(jest.fn().mockResolvedValue({ installations: [privatePod] }));
    createClientMock.mockImplementation(() => { throw new Error('reached the poll loop'); });
    await run(['--unsandboxed'], 'reached the poll loop');
    const warned = printed(warnSpy);
    expect(hostReport).toHaveBeenCalledWith('/api/agents/runtime/host-unconfined', {});
    expect(warned).toContain('nothing confines this agent');
    expect(warned).toContain('anyone in its pods, people invited later included, can direct it');
    expect(warned).toContain('no connector grants');
    expect(fs.readFileSync(recordPath).equals(before)).toBe(true);
  });

  test.each([
    ['open to join', [{ ...privatePod, joinPolicy: 'open' }]],
    ['publicly readable', [{ ...privatePod, publicRead: true }]],
    ['no fields reported', [{ type: 'installation', podId: 'pod-1' }]],
    ['one of two pods open', [privatePod, { ...privatePod, podId: 'pod-2', joinPolicy: 'open' }]],
    ['no pods', []],
  ])('the flag with a pod that is %s: refused without naming the flag again', async (_label, installations) => {
    podsRead(jest.fn().mockResolvedValue({ installations }));
    await run(['--unsandboxed'], exitSentinel);
    expect(exitSentinel.code).toBe(1);
    expect(printed(errorSpy)).toContain('publicly readable or open to join');
    expect(printed(errorSpy)).not.toContain('--unsandboxed');
    expect(printed(warnSpy)).not.toContain('nothing confines this agent');
  });

  test('a run that can\'t tell the server it has no sandbox does not start', async () => {
    hostReport.mockRejectedValueOnce(new Error('offline'));
    podsRead(jest.fn().mockResolvedValue({ installations: [privatePod] }));
    await run(['--unsandboxed'], exitSentinel);
    expect(exitSentinel.code).toBe(1);
    expect(printed(errorSpy)).toContain('could not tell the server this agent has no sandbox');
    expect(printed(warnSpy)).not.toContain('nothing confines this agent');
  });

  test('the flag when the pods cannot be read: it does not start', async () => {
    podsRead(jest.fn().mockRejectedValue(new Error('offline')));
    await run(['--unsandboxed'], exitSentinel);
    expect(exitSentinel.code).toBe(1);
    expect(printed(errorSpy)).toContain("could not read whether this agent's pods are private");
    expect(printed(warnSpy)).not.toContain('nothing confines this agent');
  });
});

describe('a saved seat from before the default sandbox', () => {
  test('starts with one line saying how to pick the default up, and its record is left byte for byte', async () => {
    saveAgentToken('byo-old', {
      agentName: 'byo-old',
      podId: 'pod-1',
      instanceUrl: 'https://api.commonly.me',
      runtimeToken: 'cm_agent_test',
      adapter: 'claude',
      workspacePath: null,
      environment: { mcp: [{ name: 'commonly', command: ['npx', '-y', '@commonlyai/mcp@latest'] }] },
    });
    const recordPath = path.join(homeTmpDir, '.commonly', 'tokens', 'byo-old.json');
    const before = fs.readFileSync(recordPath);
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
      expect(warned).toContain("[byo-old] this agent's saved settings declare no sandbox, so it runs without one");
      expect(warned).toContain('commonly agent detach byo-old --force, then either run a fresh command from the Connect page');
      expect(warned).toContain('or attach it again with an environment file that sets sandbox.trust: public');
      // The warning only tells; it does not rewrite the operator's record (#2288).
      expect(fs.readFileSync(recordPath).equals(before)).toBe(true);
    } finally {
      warnSpy.mockRestore();
      console.log.mockRestore();
      createClientMock.mockReset();
    }
  });
});
