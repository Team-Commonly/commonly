/**
 * adapters.codex.microvm.test.mjs: a public Codex seat inside the opt-in
 * microVM sandbox on native Windows (docs/cli/microvm-sandbox.md).
 *
 * Held to the same invariants as the claude adapter's microVM turn
 * (sandbox.microvm-mode.test.mjs):
 *   1. Flag off, nothing about Codex moves on any platform. Flag on, a public
 *      seat on win32 resolves to 'microvm' whatever access it declared.
 *   2. Fail closed: WHP, msb, a provider key, an unprepared turn, grants and
 *      foreign MCP servers each refuse, and nothing spawns.
 *   3. The fence is the shared one, the provider key and the seat token never
 *      reach the guest, and the guest's MCP entry declares its env table.
 *
 * Nothing here boots a VM; this Mac has no WHP, so the platform and the probe
 * are injected. cli-microsandbox-windows.yml boots one and runs a real turn.
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
const { resolveCodexSandboxMode } = await import('../src/lib/sandbox/mode.js');
const { validateEnvironmentSpec } = await import('../src/lib/environment.js');
const { hostSandboxRefusal } = await import('../src/lib/sandbox/host-check.js');
const microsandbox = await import('../src/lib/sandbox/microsandbox.js');
const codexModule = await import('../src/lib/adapters/codex.js');

const codex = codexModule.default;
const { GUEST_CODEX_HOME_LOADED, MICROVM_REPLY_MAX_BYTES, microvmGuestCodexConfig } = codexModule;
const {
  GUEST_CODEX, GUEST_HOST, GUEST_TURN_DIR, MICROVM_FLAG_ENV, microvmSeatHome, startMicrovmTurn,
} = microsandbox;

const FLAG_ON = { [MICROVM_FLAG_ENV]: '1' };

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

// ── 1. resolution ───────────────────────────────────────────────────────────

describe('resolveCodexSandboxMode', () => {
  test.each([undefined, 'workspace', 'read-only'])('flag off, a public seat keeps its own access (%s) everywhere', (mode) => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      for (const env of [{}, { [MICROVM_FLAG_ENV]: '0' }, { [MICROVM_FLAG_ENV]: 'true' }]) {
        expect(resolveCodexSandboxMode({ trust: 'public', mode }, platform, env)).toBe(mode ?? 'workspace');
      }
    }
  });

  test.each([undefined, 'workspace', 'read-only'])('flag on, a public win32 seat resolves to microvm whatever it declared (%s)', (mode) => {
    expect(resolveCodexSandboxMode({ trust: 'public', mode }, 'win32', FLAG_ON)).toBe('microvm');
  });

  test('a legacy internal declaration reads as public', () => {
    expect(resolveCodexSandboxMode({ trust: 'internal' }, 'win32', FLAG_ON)).toBe('microvm');
  });

  test('the flag changes nothing off Windows, nor for a seat that is not public', () => {
    expect(resolveCodexSandboxMode({ trust: 'public' }, 'darwin', FLAG_ON)).toBe('workspace');
    expect(resolveCodexSandboxMode({ trust: 'public', mode: 'read-only' }, 'linux', FLAG_ON)).toBe('read-only');
    expect(resolveCodexSandboxMode({ trust: 'private' }, 'win32', FLAG_ON)).toBeNull();
    expect(resolveCodexSandboxMode(undefined, 'win32', FLAG_ON)).toBeNull();
  });

  test('the default env is the process environment', async () => {
    await withFlag('1', () => expect(resolveCodexSandboxMode({ trust: 'public' }, 'win32')).toBe('microvm'));
    await withFlag(undefined, () => expect(resolveCodexSandboxMode({ trust: 'public' }, 'win32')).toBe('workspace'));
  });

  test('microvm stays host-resolved: an environment naming it still fails validation', () => {
    expect(validateEnvironmentSpec({ version: 1, sandbox: { trust: 'public', mode: 'microvm' } }).ok).toBe(false);
  });
});

describe('the run-time host check for a public Codex seat on win32', () => {
  const check = (extra) => hostSandboxRefusal({
    environment: { sandbox: { trust: 'public' } },
    adapterName: 'codex',
    platform: 'win32',
    detectBwrap: () => { throw new Error('not consulted'); },
    ...extra,
  });

  test('with the flag and WHP it passes', () => {
    expect(check({ env: FLAG_ON, detectWhp: () => ({ available: true }) })).toBeNull();
  });

  test('with a declared mode it passes too: microvm, never Codex\'s own Windows sandbox', () => {
    for (const mode of ['workspace', 'read-only']) {
      expect(check({
        environment: { sandbox: { trust: 'public', mode } }, env: FLAG_ON, detectWhp: () => ({ available: true }),
      })).toBeNull();
    }
  });

  test('without WHP it refuses with the command to turn it on', () => {
    expect(check({ env: FLAG_ON, detectWhp: () => ({ available: false, error: 'WinHvPlatform.dll is missing' }) }))
      .toMatch(/Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform/);
  });

  test('flag off, the Windows refusal is exactly as before', () => {
    const refusal = check({ env: {}, detectWhp: () => { throw new Error('not consulted'); } });
    expect(refusal).toMatch(/Codex can't enforce a sandbox on Windows/);
  });

  test('a seat with no public trust is untouched by the flag', () => {
    expect(check({
      environment: {}, env: FLAG_ON, hostUnconfined: true, detectWhp: () => { throw new Error('not consulted'); },
    })).toBeNull();
    expect(check({ environment: {}, env: FLAG_ON, detectWhp: () => { throw new Error('not consulted'); } }))
      .toMatch(/Codex can't enforce a sandbox on Windows/);
  });
});

// ── 2 and 3. the adapter's turn ─────────────────────────────────────────────

const HOST_KEY = 'sk-test-fake-codex-host-key';
const SEAT_TOKEN = 'cm_agent_test_fake_seat_token';
const PROXY_TOKEN = 'per-turn-proxy-token-codex-microvm';
// A real loopback listener on the proxy's port, so the bridge's listen(0) can
// never be handed it (F614).
const proxyPortHolder = net.createServer();
await new Promise((resolve, reject) => {
  proxyPortHolder.once('error', reject);
  proxyPortHolder.listen(0, '127.0.0.1', resolve);
});
const PROXY_PORT = proxyPortHolder.address().port;
afterAll(() => new Promise((resolve) => { proxyPortHolder.close(() => resolve()); }));
const MSB = path.join(os.tmpdir(), 'pretend-msb-codex.exe');

const cFlags = (args) => args.map((a, i) => (a === '-c' ? args[i + 1] : null)).filter(Boolean);

describe('the codex adapter in a microVM', () => {
  let cwd;
  let home;
  let scratch;
  let operatorHome;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cmv-cwd-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cmv-home-'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cmv-scratch-'));
    operatorHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cmv-operator-'));
    // A stand-in for our own server: describeMcpCommand knows it by the
    // package.json beside its src/.
    fs.mkdirSync(path.join(scratch, 'src'));
    fs.writeFileSync(path.join(scratch, 'src', 'index.js'), '');
    fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ name: '@commonlyai/mcp', version: '0.4.0' }));
    fs.writeFileSync(MSB, '');
    spawnSync.mockImplementation(() => ({ status: 0, stdout: '' }));
  });
  afterEach(() => {
    spawnSync.mockReset();
    for (const dir of [cwd, home, scratch, operatorHome]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const proxyStub = () => {
    const state = { started: [], closed: 0 };
    state.start = async (opts) => {
      state.started.push(opts);
      return {
        baseURL: `http://127.0.0.1:${PROXY_PORT}/v1`, token: PROXY_TOKEN, port: PROXY_PORT,
        close: async () => { state.closed += 1; },
      };
    };
    return state;
  };

  // The "VM": reads the turn folder while it runs (it is removed after), then
  // writes the reply where the guest's `-o` points, inside the seat HOME.
  const recorder = ({ reply = 'hello from the guest', write = 'file' } = {}) => {
    const calls = [];
    const impl = (cmd, args, opts) => {
      const mount = args.find((a) => a.endsWith(`:${GUEST_TURN_DIR}:ro`));
      const turnDir = mount ? mount.slice(0, mount.length - `:${GUEST_TURN_DIR}:ro`.length) : null;
      const read = (name) => fs.readFileSync(path.join(turnDir, name), 'utf8');
      const turn = JSON.parse(read('turn.json'));
      const configPath = path.join(home, 'codex-home', 'config.toml');
      calls.push({
        cmd,
        args,
        opts,
        turnDir,
        turn,
        turnFiles: fs.readdirSync(turnDir).map((name) => read(name)).join('\n'),
        config: fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null,
      });
      const out = turn.argv[turn.argv.indexOf('-o') + 1];
      const hostReply = path.join(home, ...out.slice('/home/seat/'.length).split('/'));
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = jest.fn();
      setTimeout(() => {
        if (write === 'file') fs.writeFileSync(hostReply, reply);
        if (typeof write === 'function') write(hostReply);
        if (write === 'link') fs.symlinkSync(path.join(operatorHome, 'secret.txt'), hostReply);
        proc.stdout.emit('data', Buffer.from('{"type":"thread.started","thread_id":"thread-mv-1"}\n{"type":"turn.completed"}\n'));
        proc.emit('close', 0);
      }, 0);
      return proc;
    };
    return { calls, impl };
  };

  const ourServer = () => [{
    name: 'commonly',
    transport: 'stdio',
    command: [process.execPath, path.join(scratch, 'src', 'index.js')],
    env: { COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}', COMMONLY_API_URL: '${COMMONLY_API_URL}' },
  }];

  const run = (impl, {
    env = { CODEX_API_KEY: HOST_KEY }, extra = {}, platform = 'win32', mcp = ourServer(), withholds = () => true,
    sandbox = { trust: 'public' },
  } = {}) => codex.spawn('hi', {
    agentName: 'cmv-seat',
    sessionId: null,
    cwd,
    runtimeToken: SEAT_TOKEN,
    instanceUrl: 'http://127.0.0.1:9',
    env: { PATH: process.env.PATH, CODEX_HOME: operatorHome, ...env },
    environment: { model: 'test-model', sandbox, mcp },
    _platform: platform,
    _mcpWithholdsTools: withholds,
    _spawnImpl: impl,
    _turnReap: false,
    _probeWhp: () => ({ available: true }),
    _prepareMicrovmHost: async () => ({ msb: MSB }),
    _microvmHome: home,
    _codexContextTokens: () => null,
    ...extra,
  });

  test('runs msb behind the shared fence, with Codex, its argv and env only in the turn folder', async () => {
    const proxy = proxyStub();
    const { calls, impl } = recorder();
    let seen = null;
    const result = await withFlag('1', () => run(impl, {
      extra: {
        _startProviderProxy: proxy.start,
        _startMicrovmTurn: async (opts) => { seen = opts; return startMicrovmTurn(opts); },
      },
    }));

    expect(result.text).toBe('hello from the guest');
    expect(result.newSessionId).toBe('thread-mv-1');
    expect(calls).toHaveLength(1);
    const [{
      cmd, args, opts, turnDir, turn, turnFiles, config,
    }] = calls;
    expect(cmd).toBe(MSB);
    expect(args[0]).toBe('run');

    // The fence: --no-net first, then DNS and exactly two host ports.
    expect(args[args.indexOf('--net-rule') - 1]).toBe('--no-net');
    expect(args.filter((a) => a === '--net-rule')).toHaveLength(1);
    const rules = args[args.indexOf('--net-rule') + 1].split(',');
    expect(rules[0]).toBe('allow@dns');
    expect(rules).toHaveLength(3);
    expect(rules).not.toContain('allow@host');
    expect(rules.every((rule) => rule === 'allow@dns' || /^allow@host:tcp:\d+$/.test(rule))).toBe(true);
    expect(rules).toContain(`allow@host:tcp:${PROXY_PORT}`);

    // Codex runs in the guest, through the proxy by its guest address.
    expect(turn.argv[0]).toBe(GUEST_CODEX);
    const flags = cFlags(turn.argv);
    expect(flags).toContain('model_provider="commonly_proxy"');
    const provider = flags.find((f) => f.startsWith('model_providers.commonly_proxy='));
    expect(provider).toContain(`base_url="http://${GUEST_HOST}:${PROXY_PORT}/v1"`);
    expect(provider).toContain('env_key="COMMONLY_CODEX_PROVIDER_TOKEN"');
    expect(turn.env.COMMONLY_CODEX_PROVIDER_TOKEN).toBe(PROXY_TOKEN);
    expect(turn.env.CODEX_HOME).toBe('/home/seat/codex-home');
    expect(Object.keys(turn.env).sort()).toEqual(['CODEX_HOME', 'COMMONLY_CODEX_PROVIDER_TOKEN', 'HOME', 'LANG', 'PATH']);
    // Read-only inside, whatever the workspace mount. Codex reads the Codex
    // home's config.toml, which the host writes for this turn alone.
    expect(turn.argv).not.toContain('--ignore-user-config');
    expect(flags.find((f) => f.startsWith('permissions.commonly_public.filesystem='))).toContain('"."="read"');
    expect(flags).toContain('permissions.commonly_public.network.enabled=false');
    expect(turn.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');

    // The guest's MCP entry runs the shim, with its env table (codex passes
    // its MCP children no environment of its own), and dials the fence's other
    // port. It lives in config.toml, never in argv or the turn folder.
    expect(config).toContain('[mcp_servers."commonly".env]');
    const bridge = /COMMONLY_MCP_BRIDGE = "([^"]+)"/.exec(config)?.[1];
    expect(bridge).toMatch(new RegExp(`^${GUEST_HOST}:\\d+$`));
    const secret = /COMMONLY_MCP_BRIDGE_SECRET = "([0-9a-f]{48})"/.exec(config)?.[1];
    expect(secret).toEqual(expect.any(String));
    expect(config).toContain('command = "node"');
    expect(config).toContain(`args = ["${GUEST_TURN_DIR}/mcp-shim.js", "commonly"]`);
    expect(/disabled_tools = \[[^\n]*commonly_self_install_into_pod/.test(config)).toBe(true);
    expect(turn.argv.join('\n')).not.toContain(secret);
    expect(turnFiles).not.toContain(secret);
    expect(flags.some((f) => f.startsWith('mcp_servers.'))).toBe(false);
    const bridgePort = Number(bridge.split(':')[1]);
    expect(rules).toContain(`allow@host:tcp:${bridgePort}`);
    expect(bridgePort).not.toBe(PROXY_PORT);

    // The host key and the seat token are nowhere the VM or msb can see.
    const everything = [args.join('\n'), JSON.stringify(opts.env), turnFiles].join('\n');
    expect(everything).not.toContain(HOST_KEY);
    expect(everything).not.toContain(SEAT_TOKEN);
    expect(Object.keys(opts.env)).not.toContain('CODEX_API_KEY');

    // The bridge runs our server on the host with the token on its file,
    // the seat's withheld tools, and no provider key in its environment.
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(cwd));
    const server = seen.hostMcpConfig.mcpServers.commonly;
    expect(server.env.COMMONLY_AGENT_TOKEN).toBeUndefined();
    expect(server.env.COMMONLY_TOKEN_FILE).toEqual(expect.any(String));
    expect(server.env.COMMONLY_API_URL).toBe('http://127.0.0.1:9');
    expect(seen.baseEnv.CODEX_API_KEY).toBeUndefined();
    expect(seen.serverEnv.COMMONLY_MCP_WITHHELD_TOOLS.split(',')).toContain('commonly_self_install_into_pod');

    // The proxy holds the key, on the Responses wire, and closes; the turn folder goes.
    expect(proxy.started).toEqual([expect.objectContaining({ keyMaterial: HOST_KEY, wire: 'openai-responses' })]);
    expect(proxy.closed).toBe(1);
    expect(fs.existsSync(turnDir)).toBe(false);
    expect(fs.readdirSync(path.join(home, 'replies'))).toEqual([]);
    // This turn's config.toml (it names the bridge secret) goes with the turn.
    expect(fs.existsSync(path.join(home, 'codex-home', 'config.toml'))).toBe(false);
  });

  test.each(['workspace', 'read-only'])('a declared %s mode runs in the microVM, read-only', async (mode) => {
    const { calls, impl } = recorder();
    await withFlag('1', () => run(impl, { sandbox: { trust: 'public', mode }, extra: { _startProviderProxy: proxyStub().start } }));
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(MSB);
    expect(cFlags(calls[0].turn.argv).find((f) => f.startsWith('permissions.commonly_public.filesystem='))).toContain('"."="read"');
  });

  test('OPENAI_API_KEY serves when CODEX_API_KEY is absent, and OPENAI_BASE_URL is the upstream', async () => {
    const proxy = proxyStub();
    const { calls, impl } = recorder();
    await withFlag('1', () => run(impl, {
      env: { OPENAI_API_KEY: HOST_KEY, OPENAI_BASE_URL: 'http://127.0.0.1:8/v1' },
      extra: { _startProviderProxy: proxy.start },
    }));
    expect(proxy.started[0]).toEqual(expect.objectContaining({ keyMaterial: HOST_KEY, provider: { baseURL: 'http://127.0.0.1:8/v1' } }));
    expect(JSON.stringify(calls[0].turn)).not.toContain(HOST_KEY);
  });

  test('a link left where the reply goes is refused, never followed', async () => {
    fs.writeFileSync(path.join(operatorHome, 'secret.txt'), 'host-only');
    const { impl } = recorder({ write: 'link' });
    await withFlag('1', async () => {
      await expect(run(impl, { extra: { _startProviderProxy: proxyStub().start } }))
        .rejects.toThrow(/refusing to touch .* in the microVM seat home/);
    });
    expect(fs.readFileSync(path.join(operatorHome, 'secret.txt'), 'utf8')).toBe('host-only');
  });

  test('a reply past the cap is cut at it, and says so', async () => {
    const { impl } = recorder({ write: (hostReply) => fs.writeFileSync(hostReply, 'a'.repeat(MICROVM_REPLY_MAX_BYTES + 5000)) });
    const result = await withFlag('1', () => run(impl, { extra: { _startProviderProxy: proxyStub().start } }));
    expect(result.text.startsWith('a'.repeat(1000))).toBe(true);
    expect(result.text).toMatch(/\[reply truncated at 256 KB\]$/);
    expect(result.text.length).toBeLessThan(MICROVM_REPLY_MAX_BYTES + 100);
  });

  test('what a turn leaves in its Codex home for the next is cleared before it', async () => {
    const codexHome = path.join(home, 'codex-home');
    fs.mkdirSync(path.join(codexHome, 'skills', 'evil'), { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'skills', 'evil', 'SKILL.md'), 'planted');
    fs.writeFileSync(path.join(codexHome, 'AGENTS.override.md'), 'planted');
    fs.writeFileSync(path.join(codexHome, 'hooks.json'), '{}');
    fs.mkdirSync(path.join(codexHome, 'sessions'));
    fs.writeFileSync(path.join(codexHome, 'sessions', 'keep.jsonl'), '{}');
    const seen = [];
    const { impl } = recorder({ write: (hostReply) => { seen.push(fs.readdirSync(codexHome).sort()); fs.writeFileSync(hostReply, 'ok'); } });
    await withFlag('1', () => run(impl, { extra: { _startProviderProxy: proxyStub().start } }));
    for (const name of GUEST_CODEX_HOME_LOADED.filter((n) => n !== 'config.toml')) expect(seen[0]).not.toContain(name);
    expect(seen[0]).toEqual(expect.arrayContaining(['config.toml', 'sessions', 'tmp']));
    expect(fs.existsSync(path.join(codexHome, 'sessions', 'keep.jsonl'))).toBe(true);
  });

  // A link planted in the seat HOME, where a turn can write: every host write,
  // removal and folder creation refuses it, and the file it points to is untouched.
  describe('links planted in the seat home', () => {
    let outside;
    beforeEach(() => {
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cmv-outside-'));
      fs.writeFileSync(path.join(outside, 'AGENTS.md'), 'host file');
      fs.writeFileSync(path.join(outside, 'AGENTS.override.md'), 'host file');
      fs.writeFileSync(path.join(outside, 'victim.txt'), 'host file');
      fs.mkdirSync(path.join(outside, 'skills'));
      fs.writeFileSync(path.join(outside, 'skills', 'keep.md'), 'host file');
    });
    afterEach(() => { fs.rmSync(outside, { recursive: true, force: true }); });

    const untouched = () => {
      expect(fs.readdirSync(outside).sort()).toEqual(['AGENTS.md', 'AGENTS.override.md', 'skills', 'victim.txt']);
      for (const name of ['AGENTS.md', 'AGENTS.override.md', 'victim.txt']) {
        expect(fs.readFileSync(path.join(outside, name), 'utf8')).toBe('host file');
      }
      expect(fs.readFileSync(path.join(outside, 'skills', 'keep.md'), 'utf8')).toBe('host file');
    };

    const refusedBeforeAnything = async (plant) => {
      plant();
      const proxy = proxyStub();
      const prepare = jest.fn(async () => ({ msb: MSB }));
      const { calls, impl } = recorder();
      await withFlag('1', async () => {
        await expect(run(impl, {
          extra: { _startProviderProxy: proxy.start, _prepareMicrovmHost: prepare },
          // Skills declared, so AGENTS.md would be written.
          sandbox: { trust: 'public' },
        })).rejects.toThrow(/refusing to touch .* in the microVM seat home/);
      });
      expect(calls).toHaveLength(0);
      expect(prepare).not.toHaveBeenCalled();
      expect(proxy.started).toHaveLength(0);
      untouched();
    };

    test('at codex-home', async () => {
      await refusedBeforeAnything(() => fs.symlinkSync(outside, path.join(home, 'codex-home'), 'dir'));
    });

    test('at a parent inside it (codex-home/tmp)', async () => {
      fs.mkdirSync(path.join(home, 'codex-home'));
      await refusedBeforeAnything(() => fs.symlinkSync(outside, path.join(home, 'codex-home', 'tmp'), 'dir'));
    });

    test('at the seat home itself', async () => {
      fs.rmSync(home, { recursive: true, force: true });
      await refusedBeforeAnything(() => fs.symlinkSync(outside, home, 'dir'));
    });

    test('at AGENTS.override.md', async () => {
      fs.mkdirSync(path.join(home, 'codex-home'));
      await refusedBeforeAnything(() => fs.symlinkSync(path.join(outside, 'AGENTS.override.md'), path.join(home, 'codex-home', 'AGENTS.override.md')));
    });

    test('at AGENTS.md', async () => {
      fs.mkdirSync(path.join(home, 'codex-home'));
      await refusedBeforeAnything(() => fs.symlinkSync(path.join(outside, 'AGENTS.md'), path.join(home, 'codex-home', 'AGENTS.md')));
    });

    test('at skills, and at a link inside skills', async () => {
      fs.mkdirSync(path.join(home, 'codex-home'));
      await refusedBeforeAnything(() => fs.symlinkSync(path.join(outside, 'skills'), path.join(home, 'codex-home', 'skills'), 'dir'));
      fs.unlinkSync(path.join(home, 'codex-home', 'skills'));
      fs.mkdirSync(path.join(home, 'codex-home', 'skills'));
      await refusedBeforeAnything(() => fs.symlinkSync(path.join(outside, 'skills'), path.join(home, 'codex-home', 'skills', 'inner'), 'dir'));
    });

    test('at the replies folder', async () => {
      await refusedBeforeAnything(() => fs.symlinkSync(outside, path.join(home, 'replies'), 'dir'));
    });

    test('a staged name planted at the old guessable path is never written through', async () => {
      fs.mkdirSync(path.join(home, 'codex-home'), { recursive: true });
      const skill = path.join(scratch, 'a-skill');
      fs.mkdirSync(skill);
      fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: a-skill\n---\n# a skill\n');
      const guessed = path.join(home, 'codex-home', `AGENTS.md.${process.pid}.tmp`);
      fs.symlinkSync(path.join(outside, 'victim.txt'), guessed);
      const { impl } = recorder();
      await withFlag('1', () => codex.spawn('hi', {
        agentName: 'cmv-seat', cwd, runtimeToken: SEAT_TOKEN, instanceUrl: 'http://127.0.0.1:9',
        env: { PATH: process.env.PATH, CODEX_HOME: operatorHome, CODEX_API_KEY: HOST_KEY },
        environment: { model: 'test-model', sandbox: { trust: 'public' }, mcp: [], skills: { claude: [skill] } },
        _platform: 'win32', _spawnImpl: impl, _turnReap: false, _probeWhp: () => ({ available: true }),
        _prepareMicrovmHost: async () => ({ msb: MSB }), _microvmHome: home, _startProviderProxy: proxyStub().start,
      }));
      expect(fs.readFileSync(path.join(home, 'codex-home', 'AGENTS.md'), 'utf8')).toContain('# a skill');
      expect(fs.lstatSync(guessed).isSymbolicLink()).toBe(true);
      untouched();
    });
  });

  test('flag off on win32, Codex takes its old path and no microVM is prepared', async () => {
    const prepare = jest.fn();
    const { calls, impl } = recorder();
    await withFlag(undefined, async () => {
      // The old path's git check runs again (the microVM turns above passed
      // without this seam, since there git runs in the guest).
      await expect(run(impl, { mcp: [], extra: { _prepareMicrovmHost: prepare, _codexVersion: null, _refuseCodeRunningGitSetup: () => {} } }))
        .rejects.toThrow(/version/i);
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  const refuses = async (message, { extra = {}, ...options } = {}) => {
    const proxy = proxyStub();
    const prepare = jest.fn(async () => ({ msb: MSB }));
    const { calls, impl } = recorder();
    await withFlag('1', async () => {
      await expect(run(impl, {
        ...options, extra: { _startProviderProxy: proxy.start, _prepareMicrovmHost: prepare, ...extra },
      })).rejects.toThrow(message);
    });
    expect(calls).toHaveLength(0);
    return { proxy, prepare };
  };

  test('without WHP it refuses, and nothing installs, starts or spawns', async () => {
    const { proxy, prepare } = await refuses(/Windows Hypervisor Platform/, {
      extra: { _probeWhp: () => ({ available: false, error: 'WinHvPlatform.dll is missing' }) },
    });
    expect(proxy.started).toHaveLength(0);
    expect(prepare).not.toHaveBeenCalled();
  });

  test('without msb it refuses, and nothing spawns', async () => {
    const { proxy } = await refuses(/SHA-256/, {
      extra: { _prepareMicrovmHost: async () => { throw new Error('microsandbox has SHA-256 x, not the pinned y'); } },
    });
    expect(proxy.started).toHaveLength(0);
  });

  test('a ChatGPT sign-in alone is refused: it has no way into the VM', async () => {
    fs.writeFileSync(path.join(operatorHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
    const { proxy, prepare } = await refuses(/need CODEX_API_KEY.*ChatGPT sign-in has no way into the VM/s, { env: {} });
    expect(proxy.started).toHaveLength(0);
    expect(prepare).not.toHaveBeenCalled();
  });

  test('a seat with sandbox.allow grants is refused: the workspace mounts read-only', async () => {
    await refuses(/remove sandbox.allow/, { sandbox: { trust: 'public', allow: ['write'] } });
  });

  test('a seat naming a folder outside its workspace is refused', async () => {
    await refuses(/read-outside/, { sandbox: { trust: 'public', filesystem: { 'read-outside': [scratch] } } });
  });

  test('another declared stdio server is refused: on the host it would run outside the VM', async () => {
    fs.mkdirSync(path.join(scratch, 'files-mcp', 'src'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'files-mcp', 'package.json'), JSON.stringify({ name: 'some-files-mcp' }));
    fs.writeFileSync(path.join(scratch, 'files-mcp', 'src', 'index.js'), '');
    await refuses(/runs only the Commonly MCP server.*files is another server/, {
      mcp: [...ourServer(), { name: 'files', transport: 'stdio', command: [process.execPath, path.join(scratch, 'files-mcp', 'src', 'index.js')] }],
    });
  });

  test('an HTTP server (the grant broker included) is refused, not silently cut off', async () => {
    await refuses(/over stdio, and broker is a http server/, {
      mcp: [...ourServer(), { name: 'broker', transport: 'http', url: 'http://127.0.0.1:9/api/mcp/grants/g' }],
    });
  });

  test('a Commonly MCP build that does not withhold tools itself is refused', async () => {
    await refuses(/does not withhold.*update @commonlyai\/mcp/, { withholds: () => false });
  });

  test('a microVM that resolved but was never prepared refuses, with no spawn', async () => {
    await refuses(/need a prepared microVM/, {
      extra: { _startMicrovmTurn: async () => ({ ports: [PROXY_PORT], mcpConfig: { mcpServers: {} }, close: async () => {} }) },
    });
  });

  test('its seat HOME is its own, apart from a Claude seat of the same name', () => {
    expect(microvmSeatHome('codex:cmv-seat', 'public')).not.toBe(microvmSeatHome('cmv-seat', 'public'));
  });
});

describe('microvmGuestCodexConfig', () => {
  test('every entry carries its env table and the public withheld tools', () => {
    const text = microvmGuestCodexConfig({
      mcpServers: {
        commonly: { command: 'node', args: ['/run/commonly/mcp-shim.js', 'commonly'], env: { COMMONLY_MCP_BRIDGE: 'h:1', COMMONLY_MCP_BRIDGE_SECRET: 's' } },
      },
    });
    expect(text).toContain('[mcp_servers."commonly".env]\nCOMMONLY_MCP_BRIDGE = "h:1"\nCOMMONLY_MCP_BRIDGE_SECRET = "s"');
    expect(text).toMatch(/\[mcp_servers\."commonly"\]\ncommand = "node"/);
    expect(text).toMatch(/disabled_tools = \["/);
  });
});
