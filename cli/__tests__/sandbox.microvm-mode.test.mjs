/**
 * sandbox.microvm-mode.test.mjs: the opt-in microVM mode on native Windows,
 * held to three invariants.
 *
 * 1. Flag off, win32 resolves exactly as before ('bwrap', which attach then
 *    refuses). The CLI publishes @latest on merge, so the default path must not move.
 * 2. 'microvm' is host-resolved, never stored: an environment file that names
 *    it fails validation.
 * 3. Fail closed everywhere: claude refuses unless win32 + flag + msb + WHP,
 *    and never falls through to a bare spawn; every other adapter refuses it.
 *
 * Nothing here boots a VM. The windows-latest workflow
 * (cli-microsandbox-windows.yml) does that.
 */
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

await jest.unstable_mockModule('child_process', () => ({
  spawnSync: jest.fn(),
  spawn: jest.fn(),
}));

const { spawnSync } = await import('child_process');
const { resolvePublicSandboxMode } = await import('../src/lib/sandbox/mode.js');
const { validateEnvironmentSpec } = await import('../src/lib/environment.js');
const { hostSandboxRefusal } = await import('../src/lib/sandbox/host-check.js');
const microsandbox = await import('../src/lib/sandbox/microsandbox.js');
const goose = await import('../src/lib/adapters/goose.js');
const pi = await import('../src/lib/adapters/pi.js');
const claude = (await import('../src/lib/adapters/claude.js')).default;
const opencode = (await import('../src/lib/adapters/opencode.js')).default;
const qwen = (await import('../src/lib/adapters/qwen.js')).default;

const {
  GUEST_CLAUDE, GUEST_HOST, GUEST_MCP_CONFIG, GUEST_TURN_DIR, MICROVM_FLAG_ENV, startMicrovmTurn,
} = microsandbox;

const FLAG_ON = { [MICROVM_FLAG_ENV]: '1' };

// The flag is read from the process environment, as in production.
const withFlag = async (value, fn) => {
  const before = process.env[MICROVM_FLAG_ENV];
  if (value === undefined) delete process.env[MICROVM_FLAG_ENV];
  else process.env[MICROVM_FLAG_ENV] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[MICROVM_FLAG_ENV];
    else process.env[MICROVM_FLAG_ENV] = before;
  }
};

const withPlatform = async (platform, fn) => {
  const before = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: before });
  }
};

describe('invariant 1: mode resolution', () => {
  test.each(['public', 'workspace', 'internal'])('flag off, win32 resolves a %s seat to bwrap, as before', (trust) => {
    expect(resolvePublicSandboxMode({ trust }, 'win32', {})).toBe('bwrap');
    expect(resolvePublicSandboxMode({ trust }, 'win32', { [MICROVM_FLAG_ENV]: '0' })).toBe('bwrap');
    expect(resolvePublicSandboxMode({ trust }, 'win32', { [MICROVM_FLAG_ENV]: 'true' })).toBe('bwrap');
  });

  test('flag on, win32 resolves a confined seat to microvm', () => {
    expect(resolvePublicSandboxMode({ trust: 'public' }, 'win32', FLAG_ON)).toBe('microvm');
    expect(resolvePublicSandboxMode({ trust: 'workspace' }, 'win32', FLAG_ON)).toBe('microvm');
  });

  test('the flag changes nothing off Windows', () => {
    expect(resolvePublicSandboxMode({ trust: 'public' }, 'darwin', FLAG_ON)).toBe('workspace');
    expect(resolvePublicSandboxMode({ trust: 'public' }, 'linux', FLAG_ON)).toBe('bwrap');
  });

  test('a declared mode still wins, and an unconfined seat keeps what it declared', () => {
    expect(resolvePublicSandboxMode({ trust: 'public', mode: 'bwrap' }, 'win32', FLAG_ON)).toBe('bwrap');
    expect(resolvePublicSandboxMode({ trust: 'private' }, 'win32', FLAG_ON)).toBeUndefined();
  });

  test('the default env is the process environment', async () => {
    await withFlag('1', () => expect(resolvePublicSandboxMode({ trust: 'public' }, 'win32')).toBe('microvm'));
    await withFlag(undefined, () => expect(resolvePublicSandboxMode({ trust: 'public' }, 'win32')).toBe('bwrap'));
  });
});

describe('invariant 2: never stored', () => {
  test('an environment file naming sandbox.mode=microvm fails validation', () => {
    const result = validateEnvironmentSpec({ version: 1, sandbox: { trust: 'public', mode: 'microvm' } });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/sandbox\.mode must be one of/);
    expect(result.errors.join('\n')).not.toMatch(/microvm,|microvm$/);
  });
});

describe('invariant 3: other adapters refuse it', () => {
  test.each(['codex', 'opencode', 'qwen', 'goose', 'pi', 'dsh'])('the run-time host check refuses %s', async (adapterName) => {
    const refusal = hostSandboxRefusal({
      environment: { sandbox: { trust: 'public' } },
      adapterName,
      platform: 'win32',
      env: FLAG_ON,
      detectWhp: () => ({ available: true }),
      detectBwrap: () => ({ available: false, error: 'none' }),
      detectSeatbelt: () => ({ available: false, error: 'none' }),
    });
    // Codex resolves no host mode and keeps its own Windows refusal.
    expect(refusal).toEqual(expect.any(String));
    if (adapterName !== 'codex') expect(refusal).toMatch(/only the claude adapter/);
  });

  test('goose and pi refuse a microvm seat themselves', async () => {
    await withFlag('1', async () => {
      await withPlatform('win32', () => {
        expect(() => goose.assertSandboxSupported({ sandbox: { trust: 'public' }, provider: 'p', model: 'm' }))
          .toThrow(/require an enforced sandbox/);
      });
      expect(() => pi.assertSandboxSupported({ sandbox: { trust: 'public' } }, 'win32'))
        .toThrow(/require an enforced sandbox/);
    });
  });

  test.each([
    ['opencode', opencode, /require an enforced sandbox mode, got microvm/],
    ['qwen', qwen, /require an enforced sandbox/],
  ])('%s refuses a microvm seat before spawning anything', async (_name, adapter, message) => {
    const spawned = jest.fn();
    await withFlag('1', () => withPlatform('win32', async () => {
      await expect(adapter.spawn('hi', {
        agentName: 'mv-seat',
        cwd: os.tmpdir(),
        env: { PATH: process.env.PATH },
        environment: { model: 'm', provider: 'p', sandbox: { trust: 'public' } },
        _spawnImpl: spawned,
      })).rejects.toThrow(message);
    }));
    expect(spawned).not.toHaveBeenCalled();
  });

  test('the run-time host check passes claude only with WHP, and names WHP when it is off', () => {
    const args = {
      environment: { sandbox: { trust: 'public' } }, adapterName: 'claude', platform: 'win32', env: FLAG_ON,
    };
    expect(hostSandboxRefusal({ ...args, detectWhp: () => ({ available: true }) })).toBeNull();
    expect(hostSandboxRefusal({ ...args, detectWhp: () => ({ available: false, error: 'WinHvPlatform.dll is missing' }) }))
      .toMatch(/Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform/);
  });

  test("the person's own --unsandboxed still runs a claude seat, as before", () => {
    expect(hostSandboxRefusal({
      environment: { sandbox: { trust: 'public' } },
      adapterName: 'claude',
      platform: 'win32',
      env: FLAG_ON,
      hostUnconfined: true,
      detectWhp: () => { throw new Error('not consulted'); },
    })).toBeNull();
  });
});

// ── the claude adapter ──────────────────────────────────────────────────────

const HOST_KEY = 'sk-ant-host-only-microvm';
// F614: the stub proxy below never listens, so a fixed port number was free
// for the bridge's real listen(0) to be handed (CI drew 41661 twice). Hold a
// real loopback listener on the proxy port for the whole file, as the real
// provider proxy holds its own for the whole turn.
const proxyPortHolder = net.createServer();
await new Promise((resolve, reject) => {
  proxyPortHolder.once('error', reject);
  proxyPortHolder.listen(0, '127.0.0.1', resolve);
});
const PROXY_PORT = proxyPortHolder.address().port;
afterAll(() => new Promise((resolve) => { proxyPortHolder.close(() => resolve()); }));
const PROXY_TOKEN = 'per-turn-proxy-token-microvm';
const MSB = path.join(os.tmpdir(), 'pretend-msb.exe');

const fakeChild = ({ stdout = '', code = 0 } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', code);
  }, 0);
  return proc;
};

const CONNECTED = [
  { type: 'system', subtype: 'init', mcp_servers: [{ name: 'commonly', status: 'connected' }] },
  { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
].map((event) => JSON.stringify(event)).join('\n');

describe('invariant 3: the claude adapter in a microVM', () => {
  let cwd;
  let home;
  let scratch;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-mv-cwd-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-mv-home-'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-mv-scratch-'));
    // A stand-in for our own server: describeMcpCommand knows it by the
    // package.json beside its src/.
    fs.mkdirSync(path.join(scratch, 'src'));
    fs.writeFileSync(path.join(scratch, 'src', 'index.js'), '');
    fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ name: '@commonlyai/mcp', version: '0.4.0' }));
    // Windows resolves the launch target before spawning, so it must exist.
    fs.writeFileSync(MSB, '');
    spawnSync.mockImplementation((cmd) => (cmd === 'which'
      ? { status: 0, stdout: '/usr/bin/true\n' }
      : { status: 0, stdout: '' }));
  });
  afterEach(() => {
    spawnSync.mockReset();
    for (const dir of [cwd, home, scratch]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const proxyStub = () => {
    const state = { started: [], closed: 0 };
    state.start = async (opts) => {
      state.started.push(opts);
      return {
        baseURL: `http://127.0.0.1:${PROXY_PORT}/`, token: PROXY_TOKEN, port: PROXY_PORT,
        close: async () => { state.closed += 1; },
      };
    };
    return state;
  };

  // Reads the turn folder while the "VM" runs: it is removed after the turn.
  const recorder = () => {
    const calls = [];
    const impl = (cmd, args, opts) => {
      const mount = args[args.indexOf(`${GUEST_TURN_DIR}:ro`)] || args.find((a) => a.endsWith(`:${GUEST_TURN_DIR}:ro`));
      const turnDir = mount ? mount.slice(0, mount.length - `:${GUEST_TURN_DIR}:ro`.length) : null;
      const read = (name) => (turnDir ? fs.readFileSync(path.join(turnDir, name), 'utf8') : null);
      calls.push({
        cmd, args, opts, turnDir, turn: JSON.parse(read('turn.json')), mcp: JSON.parse(read('mcp.json')),
      });
      return fakeChild({ stdout: CONNECTED });
    };
    return { calls, impl };
  };

  const ourServer = () => [{ name: 'commonly', transport: 'stdio', command: [process.execPath, path.join(scratch, 'src', 'index.js')] }];
  const run = (impl, {
    env = { ANTHROPIC_API_KEY: HOST_KEY }, extra = {}, platform = 'win32', mcp = ourServer(), withholds = () => true,
  } = {}) => claude.spawn('hi', {
    agentName: 'mv-seat',
    sessionId: null,
    cwd,
    skillMountDir: scratch,
    env: { PATH: process.env.PATH, ...env },
    environment: {
      model: 'test-model',
      sandbox: { trust: 'public' },
      mcp,
    },
    _platform: platform,
    _mcpWithholdsTools: withholds,
    _spawnImpl: impl,
    _probeWhp: () => ({ available: true }),
    _prepareMicrovmHost: async () => ({ msb: MSB }),
    _microvmHome: home,
    ...extra,
  });

  test('the stub proxy port is held, so the bridge cannot be handed it (F614)', async () => {
    const probe = net.createServer();
    const outcome = await new Promise((resolve) => {
      probe.once('error', (error) => resolve(error.code));
      probe.listen(PROXY_PORT, '127.0.0.1', () => probe.close(() => resolve('bound')));
    });
    expect(outcome).toBe('EADDRINUSE');
  });

  test('runs msb behind the fence, with the guest argv and env only in the turn folder', async () => {
    const proxy = proxyStub();
    const { calls, impl } = recorder();
    await withFlag('1', () => run(impl, { extra: { _startProviderProxy: proxy.start } }));

    expect(calls).toHaveLength(1);
    const [{
      cmd, args, opts, turnDir, turn, mcp,
    }] = calls;
    expect(cmd).toBe(MSB);
    expect(args[0]).toBe('run');

    // The fence: --no-net, DNS, the proxy port and one bridge port, nothing else.
    expect(args[args.indexOf('--net-rule') - 1]).toBe('--no-net');
    const rules = args[args.indexOf('--net-rule') + 1].split(',');
    expect(rules[0]).toBe('allow@dns');
    expect(rules).toContain(`allow@host:tcp:${PROXY_PORT}`);
    expect(rules).toHaveLength(3);
    expect(rules.every((rule) => rule === 'allow@dns' || /^allow@host:tcp:\d+$/.test(rule))).toBe(true);

    // Claude runs in the guest, with the guest MCP config and the proxy.
    expect(turn.argv[0]).toBe(GUEST_CLAUDE);
    expect(turn.argv[turn.argv.indexOf('--mcp-config') + 1]).toBe(GUEST_MCP_CONFIG);
    expect(turn.env.ANTHROPIC_API_KEY).toBe(PROXY_TOKEN);
    expect(turn.env.ANTHROPIC_BASE_URL).toBe(`http://${GUEST_HOST}:${PROXY_PORT}/`);
    expect(mcp.mcpServers.commonly.args).toEqual([`${GUEST_TURN_DIR}/mcp-shim.js`, 'commonly']);
    expect(mcp.mcpServers.commonly.env.COMMONLY_MCP_BRIDGE).toMatch(new RegExp(`^${GUEST_HOST}:\\d+$`));
    // The fence's other port is exactly the bridge the guest's shims dial.
    const bridgePort = Number(mcp.mcpServers.commonly.env.COMMONLY_MCP_BRIDGE.split(':')[1]);
    expect(rules).toContain(`allow@host:tcp:${bridgePort}`);
    expect(bridgePort).not.toBe(PROXY_PORT);

    // The host key is nowhere the VM or msb can see.
    const everything = [args.join('\n'), JSON.stringify(opts.env), JSON.stringify(turn), JSON.stringify(mcp)].join('\n');
    expect(everything).not.toContain(HOST_KEY);
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(args).not.toContain('-e');

    // The proxy closes and the turn folder is gone afterwards.
    expect(proxy.closed).toBe(1);
    expect(fs.existsSync(turnDir)).toBe(false);
  });

  test('the bridged MCP servers run in the workspace and withhold the seat\'s tools themselves', async () => {
    const proxy = proxyStub();
    const { impl } = recorder();
    let seen = null;
    await withFlag('1', () => run(impl, {
      extra: {
        _startProviderProxy: proxy.start,
        _startMicrovmTurn: async (opts) => { seen = opts; return startMicrovmTurn(opts); },
      },
    }));
    expect(seen.cwd).toBe(cwd);
    const withheld = seen.serverEnv.COMMONLY_MCP_WITHHELD_TOOLS.split(',');
    // A public seat never gets self-install (F118), whoever woke it.
    expect(withheld).toContain('commonly_self_install_into_pod');
    expect(seen.vars.ANTHROPIC_API_KEY).toBe(PROXY_TOKEN);
  });

  test('a microVM that was resolved but never prepared refuses in prepareArgv, with no spawn', async () => {
    const proxy = proxyStub();
    const { calls, impl } = recorder();
    await withFlag('1', async () => {
      await expect(run(impl, {
        extra: {
          _startProviderProxy: proxy.start,
          _startMicrovmTurn: async () => ({ ports: [PROXY_PORT], mcpConfig: { mcpServers: {} }, close: async () => {} }),
        },
      })).rejects.toThrow(/need a prepared microVM/);
    });
    expect(calls).toHaveLength(0);
  });

  test('a workspace seat with grants is refused: the workspace mounts read-only', async () => {
    const proxy = proxyStub();
    const { calls, impl } = recorder();
    await withFlag('1', async () => {
      await expect(claude.spawn('hi', {
        agentName: 'mv-seat',
        cwd,
        skillMountDir: scratch,
        env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: HOST_KEY },
        environment: { model: 'm', sandbox: { trust: 'workspace', allow: ['write'] } },
        _platform: 'win32',
        _spawnImpl: impl,
        _probeWhp: () => ({ available: true }),
        _prepareMicrovmHost: async () => ({ msb: MSB }),
        _microvmHome: home,
        _startProviderProxy: proxy.start,
        _publicClaudeState: home,
      })).rejects.toThrow(/remove sandbox.allow/);
    });
    expect(calls).toHaveLength(0);
    expect(proxy.started).toHaveLength(0);
  });

  const refuses = async (message, { env, extra, platform, flag = '1' } = {}) => {
    const proxy = proxyStub();
    const { calls, impl } = recorder();
    await withFlag(flag, async () => {
      await expect(run(impl, { env, extra: { _startProviderProxy: proxy.start, ...extra }, platform })).rejects.toThrow(message);
    });
    expect(calls).toHaveLength(0);
    return proxy;
  };

  test('another declared stdio server is refused: on the host it would run outside the VM', async () => {
    fs.mkdirSync(path.join(scratch, 'files-mcp', 'src'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'files-mcp', 'package.json'), JSON.stringify({ name: 'some-files-mcp' }));
    fs.writeFileSync(path.join(scratch, 'files-mcp', 'src', 'index.js'), '');
    const proxy = proxyStub();
    const { calls, impl } = recorder();
    await withFlag('1', async () => {
      await expect(run(impl, {
        mcp: [...ourServer(), { name: 'files', transport: 'stdio', command: [process.execPath, path.join(scratch, 'files-mcp', 'src', 'index.js')] }],
        extra: { _startProviderProxy: proxy.start },
      })).rejects.toThrow(/runs only the Commonly MCP server.*files is another server/);
    });
    expect(calls).toHaveLength(0);
  });

  test('a Commonly MCP build that does not withhold tools itself is refused', async () => {
    const proxy = proxyStub();
    const { calls, impl } = recorder();
    const withholds = jest.fn(() => false);
    await withFlag('1', async () => {
      await expect(run(impl, { withholds, extra: { _startProviderProxy: proxy.start } }))
        .rejects.toThrow(/does not withhold.*update @commonlyai\/mcp/);
    });
    expect(withholds).toHaveBeenCalledWith([process.execPath, path.join(scratch, 'src', 'index.js')]);
    expect(calls).toHaveLength(0);
  });

  test('without WHP it refuses, and nothing spawns or starts', async () => {
    const proxy = await refuses(/Windows Hypervisor Platform/, {
      extra: { _probeWhp: () => ({ available: false, error: 'WinHvPlatform.dll is missing' }) },
    });
    expect(proxy.started).toHaveLength(0);
  });

  test('without msb it refuses, and nothing spawns', async () => {
    await refuses(/SHA-256/, {
      extra: { _prepareMicrovmHost: async () => { throw new Error('microsandbox has SHA-256 x, not the pinned y'); } },
    });
  });

  test('without ANTHROPIC_API_KEY it refuses, since the VM reaches the model only through the proxy', async () => {
    await refuses(/need ANTHROPIC_API_KEY/, { env: {} });
  });

  test('a public seat naming a folder outside its workspace is refused', async () => {
    const proxy = proxyStub();
    const { calls, impl } = recorder();
    await withFlag('1', async () => {
      await expect(claude.spawn('hi', {
        agentName: 'mv-seat',
        cwd,
        skillMountDir: scratch,
        env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: HOST_KEY },
        environment: { model: 'm', sandbox: { trust: 'public', filesystem: { 'read-outside': [scratch] } } },
        _platform: 'win32',
        _spawnImpl: impl,
        _probeWhp: () => ({ available: true }),
        _prepareMicrovmHost: async () => ({ msb: MSB }),
        _microvmHome: home,
        _startProviderProxy: proxy.start,
      })).rejects.toThrow(/read-outside/);
    });
    expect(calls).toHaveLength(0);
  });
});
