/**
 * adapters.pi.public.test.mjs — a public pi seat runs inside Seatbelt (F113b).
 *
 * Before this, pi refused every declared sandbox (assertNoSandboxDeclared), so
 * a pi seat could never sit in a stranger-readable pod. A public pi turn now
 * runs as `sandbox-exec -p <profile> pi …`: the bridge (pi-commonly-mcp.mjs)
 * is an in-process extension of that pi, so the MCP servers it spawns are
 * children of the jailed process and inherit its profile, and pi gets no
 * built-in tool at all (no shell, no file reads), the way the other public
 * adapters run. The real `pi` binary is never invoked here: `_spawnImpl`
 * replaces the spawn, and a fake package stands in for pi's install tree.
 */
import { EventEmitter } from 'events';
import {
  chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile,
} from 'fs/promises';
import { Writable } from 'stream';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { homedir } from 'os';
import pi, {
  PI_BUILTIN_TOOLS, TESTED_PI_VERSIONS, assertSandboxSupported, seatHome,
} from '../src/lib/adapters/pi.js';
import { registrableTools } from '../src/lib/adapters/pi-mcp-client.mjs';
import { buildSeatbeltProfile } from '../src/lib/sandbox/seatbelt.js';
import { PUBLIC_SEAT_WITHHELD_TOOLS, PUBLIC_WITHHELD_TOOLS } from '../src/lib/public-withheld-tools.js';

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'adapters');

const event = (obj) => `${JSON.stringify(obj)}\n`;
const assistant = (text) => event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });

const fakeChild = ({ stdout = '', code = 0 } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.fd3Payload = '';
  const fd3 = new Writable({ write(chunk, _enc, done) { proc.fd3Payload += chunk.toString(); done(); } });
  fd3.on('error', () => {});
  proc.stdio = [null, proc.stdout, proc.stderr, fd3];
  proc.kill = () => {};
  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', code);
  }, 5);
  return proc;
};
const makeSpawnImpl = (out) => {
  const calls = [];
  const impl = (cmd, args, opts) => { const proc = fakeChild(out); calls.push({ cmd, args, opts, proc }); return proc; };
  return { impl, calls };
};

// The wrap is captured rather than run, so the argv contract is checked on any
// host; the darwin-only test below runs the real profile builder.
const captureWrap = () => {
  const seen = [];
  const wrap = (inner, opts) => { seen.push({ inner, opts }); return ['/usr/bin/sandbox-exec', '-p', '(version 1)(deny default)', ...inner]; };
  return { wrap, seen };
};

let root;
let home;
let workspace;
let binDir;
let packageRoot;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-public-')));
  home = join(root, 'pi-home');
  workspace = join(root, 'workspace');
  // pi installs as an npm package whose bin is a symlink into dist/cli.js.
  packageRoot = join(root, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
  binDir = join(root, 'bin');
  await Promise.all([mkdir(join(packageRoot, 'dist'), { recursive: true }), mkdir(binDir), mkdir(workspace)]);
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
  await writeFile(join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  await symlink(join(packageRoot, 'dist', 'cli.js'), join(binDir, 'pi'));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const publicCtx = (over = {}) => ({
  cwd: workspace,
  agentName: 'kai-public',
  runtimeToken: 'cm_agent_secret',
  instanceUrl: 'https://api.example',
  env: { PATH: `${binDir}:/usr/bin`, COMMONLY_LITELLM_KEY: 'sk-real-provider-key', OPERATOR_SECRET: 'do-not-leak' },
  environment: {
    model: 'deepseek-v4-flash',
    sandbox: { trust: 'public' },
    mcp: [{ name: 'commonly', transport: 'stdio', command: ['node', '/opt/mcp/server.js'], env: { COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' } }],
  },
  _piHome: home,
  _platform: 'darwin',
  _version: TESTED_PI_VERSIONS[0],
  _bridgePath: join(ADAPTERS_DIR, 'pi-commonly-mcp.mjs'),
  ...over,
});

const innerOf = (call) => call.args.slice(2);
const flagValue = (argv, flag) => argv[argv.indexOf(flag) + 1];

describe('a public pi turn runs inside Seatbelt', () => {
  test('the one process spawned is sandbox-exec, and pi with its bridge is the argv inside it', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('hello from the jail') });
    const { wrap, seen } = captureWrap();
    const res = await pi.spawn('hi', publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: wrap }));
    expect(res.text).toBe('hello from the jail');
    // Exactly one spawn, and it is the jail: nothing pi launches is started by
    // the adapter outside it.
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('/usr/bin/sandbox-exec');
    expect(calls[0].args[0]).toBe('-p');
    const inner = innerOf(calls[0]);
    expect(inner).toEqual(seen[0].inner);
    expect(inner[0]).toBe(join(binDir, 'pi'));
    // The MCP bridge is loaded by the jailed pi, so the servers it spawns are
    // children of the jailed process.
    expect(inner[inner.indexOf('-e') + 1]).toBe(join(ADAPTERS_DIR, 'pi-commonly-mcp.mjs'));
    // fd 3 still carries the server list through the wrap.
    expect(calls[0].opts.stdio).toEqual(['ignore', 'pipe', 'pipe', 'pipe']);
    expect(calls[0].opts.cwd).toBe(workspace);
  });

  test('the profile is scoped to the workspace, the seat home, pi\'s package and the bridge code, with the provider on loopback only', async () => {
    const { impl } = makeSpawnImpl({ stdout: assistant('ok') });
    const { wrap, seen } = captureWrap();
    await pi.spawn('hi', publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: wrap }));
    const { opts } = seen[0];
    expect(opts.workspacePath).toBe(workspace);
    expect(opts.workspaceAccess).toBe('write');
    expect(opts.statePath).toBe(`${home}-public`);
    expect(opts.executablePath).toBe(join(binDir, 'pi'));
    expect(opts.readOnlyDirectories).toEqual(expect.arrayContaining([packageRoot, dirname(ADAPTERS_DIR)]));
    expect(opts.loopbackNetworkPorts).toHaveLength(1);
    // Processes in the jail may inspect only themselves, not the pi that holds
    // the seat token in memory.
    expect(opts.processInfo).toBe('self');
    // The provider's real key stays in this process; pi is handed a loopback
    // proxy and that proxy's per-turn token.
    const models = JSON.parse(await readFile(join(`${home}-public`, 'agent', 'models.json'), 'utf8'));
    expect(models.providers.litellm.baseUrl).toBe(`http://127.0.0.1:${opts.loopbackNetworkPorts[0]}/v1`);
  });

  test('read-only mode maps to a read-only workspace', async () => {
    const { impl } = makeSpawnImpl({ stdout: assistant('ok') });
    const { wrap, seen } = captureWrap();
    const ctx = publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: wrap });
    ctx.environment = { ...ctx.environment, sandbox: { trust: 'public', mode: 'read-only' } };
    await pi.spawn('hi', ctx);
    expect(seen[0].opts.workspaceAccess).toBe('read');
  });

  test('pi gets no built-in tool and no shell extension, and the withheld Commonly tools are excluded', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('ok') });
    const { wrap } = captureWrap();
    await pi.spawn('hi', publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: wrap }));
    const inner = innerOf(calls[0]);
    expect(inner).toContain('--no-builtin-tools');
    const excluded = flagValue(inner, '--exclude-tools').split(',');
    expect(excluded).toEqual(expect.arrayContaining([...PI_BUILTIN_TOOLS, ...PUBLIC_SEAT_WITHHELD_TOOLS]));
    expect(PI_BUILTIN_TOOLS).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']));
    // The shell extension re-registers `bash`; a public turn does not load it.
    expect(inner.join(' ')).not.toMatch(/pi-shell-env\.mjs/);
    expect(inner).toContain('--no-approve');
    // ...and the bridge is told the same list, so it never registers them.
    const servers = JSON.parse(calls[0].proc.fd3Payload);
    expect(servers[0].withheldTools).toEqual([...PUBLIC_SEAT_WITHHELD_TOOLS]);
  });

  describe('F145: memory writes on a turn the owner woke', () => {
    const MEMORY = ['commonly_write_agent_memory', 'commonly_save_my_memory', 'commonly_log_cycle'];
    const NOT_MEMORY = ['commonly_self_install_into_pod', 'commonly_delete_message', 'commonly_attach_file', 'commonly_catch_up'];
    const turn = async (over) => {
      const { impl, calls } = makeSpawnImpl({ stdout: assistant('ok') });
      const { wrap } = captureWrap();
      await pi.spawn('hi', publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: wrap, memoryLongTerm: '', ...over }));
      const inner = innerOf(calls[0]);
      return {
        inner,
        excluded: flagValue(inner, '--exclude-tools').split(','),
        withheld: JSON.parse(calls[0].proc.fd3Payload)[0].withheldTools,
      };
    };

    test('an owner-woken turn gets the three memory tools back on both layers, and nothing else', async () => {
      const { inner, excluded, withheld } = await turn({ ownerWoken: true });
      for (const tool of MEMORY) {
        expect(excluded).not.toContain(tool);
        expect(withheld).not.toContain(tool);
      }
      for (const tool of NOT_MEMORY) {
        expect(excluded).toContain(tool);
        expect(withheld).toContain(tool);
      }
      expect(excluded).toEqual(expect.arrayContaining(PI_BUILTIN_TOOLS));
      expect(inner[inner.indexOf('-p') + 1]).toBeDefined();
      expect(inner.join(' ')).toContain('commonly_save_my_memory');
    });

    test('the next turn on the same session has them taken away again', async () => {
      const first = await turn({ ownerWoken: true, sessionId: 'pi-session' });
      expect(first.excluded).not.toContain('commonly_save_my_memory');
      const sessionDir = flagValue(first.inner, '--session-dir');
      await writeFile(join(sessionDir, 'x_pi-session.jsonl'), '{}\n');
      const second = await turn({ sessionId: 'pi-session' });
      expect(second.inner).toContain('--session');
      for (const tool of MEMORY) {
        expect(second.excluded).toContain(tool);
        expect(second.withheld).toContain(tool);
      }
      expect(second.inner.join(' ')).not.toContain('commonly_save_my_memory({');
    });
  });

  test('F118 + F141: all seven public-seat tools are withheld on both layers, and reading memory stays offered', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('ok') });
    const { wrap } = captureWrap();
    await pi.spawn('hi', publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: wrap }));
    const withheld = [
      'commonly_attach_file', 'commonly_catch_up', 'commonly_self_install_into_pod',
      'commonly_write_agent_memory', 'commonly_save_my_memory', 'commonly_log_cycle',
      'commonly_delete_message',
    ];
    const excluded = flagValue(innerOf(calls[0]), '--exclude-tools').split(',');
    expect(excluded).toEqual(expect.arrayContaining(withheld));
    expect(excluded).not.toContain('commonly_read_agent_memory');
    const [server] = JSON.parse(calls[0].proc.fd3Payload);
    expect(server.withheldTools).toEqual(expect.arrayContaining(withheld));
    const offered = registrableTools(
      [...withheld, 'commonly_read_agent_memory', 'commonly_post_message'].map((name) => ({ name })), server,
    ).map((t) => t.name);
    expect(offered).toEqual(['commonly_read_agent_memory', 'commonly_post_message']);
  });

  test('F118: the public prompt never names the save tool it is not offered; a private one still does', async () => {
    const { wrap } = captureWrap();
    for (const memoryLongTerm of ['', 'gate held on #12']) {
      const pub = makeSpawnImpl({ stdout: assistant('ok') });
      await pi.spawn('hi', publicCtx({ _spawnImpl: pub.impl, _wrapArgvWithSeatbelt: wrap, memoryLongTerm }));
      const prompt = innerOf(pub.calls[0]).at(-1);
      expect(prompt).not.toContain('commonly_save_my_memory');
      expect(prompt).toContain('read-only on this turn');
    }
    const priv = makeSpawnImpl({ stdout: assistant('ok') });
    const ctx = publicCtx({ _spawnImpl: priv.impl, memoryLongTerm: '' });
    ctx.environment = { model: 'deepseek-v4-flash' };
    await pi.spawn('hi', ctx);
    expect(priv.calls[0].args.at(-1)).toContain('commonly_save_my_memory');
  });

  test('the jailed pi gets a scrubbed environment: no operator variables, no provider key, no seat token', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('ok') });
    const { wrap } = captureWrap();
    await pi.spawn('hi', publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: wrap }));
    const { env } = calls[0].opts;
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain('do-not-leak');
    expect(serialized).not.toContain('sk-real-provider-key');
    expect(serialized).not.toContain('cm_agent_secret');
    expect(env.COMMONLY_LITELLM_KEY).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(env.HOME).toBe(`${home}-public`);
    expect(env.PI_CODING_AGENT_DIR).toBe(join(`${home}-public`, 'agent'));
    expect(env.PATH).toBe(`${binDir}:/usr/bin`);
  });

  test('a turn with no declared MCP still runs jailed and tool-less', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('ok') });
    const { wrap } = captureWrap();
    const ctx = publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: wrap });
    ctx.environment = { ...ctx.environment, mcp: [] };
    await pi.spawn('hi', ctx);
    expect(calls[0].cmd).toBe('/usr/bin/sandbox-exec');
    expect(innerOf(calls[0])).not.toContain('-e');
    expect(flagValue(innerOf(calls[0]), '--exclude-tools')).toContain('bash');
  });

  test('a legacy internal trust is confined the same way', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('ok') });
    const { wrap } = captureWrap();
    const ctx = publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: wrap });
    ctx.environment = { ...ctx.environment, sandbox: { trust: 'internal' } };
    await pi.spawn('hi', ctx);
    expect(calls[0].cmd).toBe('/usr/bin/sandbox-exec');
  });

  const realSeatbelt = process.platform === 'darwin' ? test : test.skip;
  realSeatbelt('the real profile builder produces a deny-default profile holding the seat home', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('ok') });
    await pi.spawn('hi', publicCtx({ _spawnImpl: impl }));
    expect(calls[0].cmd).toBe('/usr/bin/sandbox-exec');
    const profile = calls[0].args[1];
    expect(profile).toContain('(deny default)');
    expect(profile).toContain(`(subpath "${home}-public")`);
    expect(profile).not.toContain(`(subpath "${home}")`);
    expect(profile).toContain(`(subpath "${packageRoot}")`);
    expect(innerOf(calls[0])[0]).toBe(join(binDir, 'pi'));
  });
});

describe('public and private turns keep separate pi homes', () => {
  test('seatHome: the private path is unchanged, the public one is its own sibling', () => {
    const hash = createHash('sha256').update('kai').digest('hex').slice(0, 20);
    expect(seatHome({ agentName: 'kai' })).toBe(join(homedir(), '.commonly', 'pi-homes', hash));
    expect(seatHome({ agentName: 'kai' }, { publicSeat: true }))
      .toBe(join(homedir(), '.commonly', 'pi-homes', `${hash}-public`));
    expect(seatHome({ _piHome: '/h' })).toBe('/h');
    expect(seatHome({ _piHome: '/h' }, { publicSeat: true })).toBe('/h-public');
  });

  test('a public turn never gets the private home or session dir', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('ok') });
    const { wrap, seen } = captureWrap();
    await pi.spawn('hi', publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: wrap }));
    const inner = innerOf(calls[0]);
    expect(flagValue(inner, '--session-dir')).toBe(join(`${home}-public`, 'sessions'));
    const everything = JSON.stringify({ inner, env: calls[0].opts.env, opts: seen[0].opts });
    expect(everything.split(`${home}-public`).join('')).not.toContain(home);
  });

  test('a private turn keeps the home it always had', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('ok') });
    const ctx = publicCtx({ _spawnImpl: impl });
    ctx.environment = { model: 'deepseek-v4-flash' };
    await pi.spawn('hi', ctx);
    expect(flagValue(calls[0].args, '--session-dir')).toBe(join(home, 'sessions'));
    expect(calls[0].opts.env.PI_CODING_AGENT_DIR).toBe(join(home, 'agent'));
  });

  test('a session the private seat wrote is not resumed by a public turn of the same seat', async () => {
    const privateId = '11111111-2222-4333-8444-555555555555';
    await mkdir(join(home, 'sessions'), { recursive: true });
    await writeFile(join(home, 'sessions', `2026-11-04_${privateId}.jsonl`), '{"private":"history"}\n');
    // The private seat resumes it...
    const priv = makeSpawnImpl({ stdout: assistant('ok') });
    const privateCtx = publicCtx({ _spawnImpl: priv.impl, sessionId: privateId });
    privateCtx.environment = { model: 'deepseek-v4-flash' };
    expect((await pi.spawn('hi', privateCtx)).newSessionId).toBe(privateId);
    expect(flagValue(priv.calls[0].args, '--session')).toBe(privateId);
    // ...the same id handed to a public turn starts fresh in the public home.
    const pub = makeSpawnImpl({ stdout: assistant('ok') });
    const { wrap } = captureWrap();
    const res = await pi.spawn('hi', publicCtx({ _spawnImpl: pub.impl, _wrapArgvWithSeatbelt: wrap, sessionId: privateId }));
    const inner = innerOf(pub.calls[0]);
    expect(inner).not.toContain('--session');
    expect(inner).not.toContain(privateId);
    expect(res.newSessionId).not.toBe(privateId);
  });
});

describe('a public pi turn refuses what it cannot confine', () => {
  const refuses = async (mutate, pattern) => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('ok') });
    const { wrap } = captureWrap();
    const ctx = mutate(publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: wrap }));
    await expect(pi.spawn('hi', ctx)).rejects.toThrow(pattern);
    expect(calls).toHaveLength(0);
  };

  test('off macOS (no Seatbelt; pi has no bwrap path yet)', () => refuses(
    (ctx) => ({ ...ctx, _platform: 'linux' }), /pi adapter: public seats .*macOS Seatbelt/,
  ));
  test('an explicit bwrap mode', () => refuses(
    (ctx) => ({ ...ctx, environment: { ...ctx.environment, sandbox: { trust: 'public', mode: 'bwrap' } } }), /macOS Seatbelt/,
  ));
  test('an untested pi version, since the tool flags it relies on must exist', () => refuses(
    (ctx) => ({ ...ctx, _version: '0.1.0' }), /untested pi version 0\.1\.0/,
  ));
  test('a provider API the loopback proxy does not carry', () => refuses(
    (ctx) => ({ ...ctx, environment: { ...ctx.environment, provider: { api: 'anthropic-messages' } } }), /openai-completions/,
  ));
  test('a declared read-outside grant', () => refuses(
    (ctx) => ({ ...ctx, environment: { ...ctx.environment, sandbox: { trust: 'public', filesystem: { 'read-outside': ['/etc'] } } } }), /read-outside/,
  ));
  test('a public mode of none', () => refuses(
    (ctx) => ({ ...ctx, environment: { ...ctx.environment, sandbox: { trust: 'public', mode: 'none' } } }), /enforced sandbox/,
  ));
  test('a pi whose package tree cannot be found', () => refuses(
    (ctx) => ({ ...ctx, env: { ...ctx.env, PATH: '/nonexistent' } }), /pi executable/,
  ));
  test('a workspace trust, which stays claude-only', () => refuses(
    (ctx) => ({ ...ctx, environment: { ...ctx.environment, sandbox: { trust: 'workspace' } } }), /claude-only/,
  ));
});

describe('the public version probe', () => {
  // A fake pi whose --version sleeps, then answers, and counts every probe.
  const writeProbePi = async ({ answer = '0.84.1', sleepMs = 0 } = {}) => {
    const counter = join(root, 'probes.log');
    await writeFile(join(packageRoot, 'dist', 'cli.js'), [
      `#!${process.execPath}`,
      'if (process.argv.includes("--version")) {',
      `  require("fs").appendFileSync(${JSON.stringify(counter)}, "x");`,
      `  setTimeout(() => process.stdout.write(${JSON.stringify(`${answer}\n`)}), ${sleepMs});`,
      '}',
      '',
    ].join('\n'));
    await chmod(join(packageRoot, 'dist', 'cli.js'), 0o755);
    return async () => (await readFile(counter, 'utf8').catch(() => '')).length;
  };
  const probeCtx = (over = {}) => {
    const ctx = publicCtx({ _wrapArgvWithSeatbelt: captureWrap().wrap, ...over });
    delete ctx._version;
    return ctx;
  };

  test('runs off the event loop: a timer keeps firing while a slow pi answers', async () => {
    await writeProbePi({ sleepMs: 400 });
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    try {
      const { impl } = makeSpawnImpl({ stdout: assistant('ok') });
      await pi.spawn('hi', probeCtx({ _spawnImpl: impl }));
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThanOrEqual(8);
  });

  test('a second turn on the same binary does not probe again', async () => {
    const probes = await writeProbePi();
    for (let i = 0; i < 2; i += 1) {
      const { impl, calls } = makeSpawnImpl({ stdout: assistant('ok') });
      await pi.spawn('hi', probeCtx({ _spawnImpl: impl }));
      expect(calls).toHaveLength(1);
    }
    expect(await probes()).toBe(1);
  });

  test('a binary whose mtime changed is probed again', async () => {
    const probes = await writeProbePi();
    const first = makeSpawnImpl({ stdout: assistant('ok') });
    await pi.spawn('hi', probeCtx({ _spawnImpl: first.impl }));
    const later = new Date(Date.now() + 60_000);
    await utimes(join(packageRoot, 'dist', 'cli.js'), later, later);
    const second = makeSpawnImpl({ stdout: assistant('ok') });
    await pi.spawn('hi', probeCtx({ _spawnImpl: second.impl }));
    expect(await probes()).toBe(2);
  });

  test('an unknown version is refused, and is not cached', async () => {
    const probes = await writeProbePi({ answer: 'not a version' });
    for (let i = 0; i < 2; i += 1) {
      const { impl, calls } = makeSpawnImpl({ stdout: assistant('ok') });
      await expect(pi.spawn('hi', probeCtx({ _spawnImpl: impl }))).rejects.toThrow(/untested pi version unknown/);
      expect(calls).toHaveLength(0);
    }
    expect(await probes()).toBe(2);
  });
});

describe('a public pi seat with a cold Commonly MCP', () => {
  test('the shipped npx server with no host-prepared build refuses before pi starts', async () => {
    const mcpHome = join(root, 'mcp-home');
    await mkdir(mcpHome);
    // A held warm lock keeps prepareMcpSpawn from starting a real warm here.
    await writeFile(join(mcpHome, '.warm.lock'), 'warming\n');
    const saved = process.env.COMMONLY_MCP_HOME;
    process.env.COMMONLY_MCP_HOME = mcpHome;
    try {
      const { impl, calls } = makeSpawnImpl({ stdout: assistant('must not run') });
      const ctx = publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: captureWrap().wrap });
      ctx.environment = { ...ctx.environment, mcp: [{ name: 'commonly', transport: 'stdio', command: ['npx', '-y', '@commonlyai/mcp@latest'] }] };
      await expect(pi.spawn('hi', ctx)).rejects.toMatchObject({ code: 'public_mcp_unavailable' });
      expect(calls.length).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.COMMONLY_MCP_HOME;
      else process.env.COMMONLY_MCP_HOME = saved;
    }
  });
});

describe('a private pi seat is unchanged', () => {
  test('no sandbox: bare pi, the shell extension, the real provider key, no tool exclusions', async () => {
    const { impl, calls } = makeSpawnImpl({ stdout: assistant('ok') });
    const { wrap, seen } = captureWrap();
    const ctx = publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: wrap });
    ctx.environment = { model: 'deepseek-v4-flash' };
    await pi.spawn('hi', ctx);
    expect(seen).toHaveLength(0);
    expect(calls[0].cmd).toBe('pi');
    expect(calls[0].args.join(' ')).toMatch(/pi-shell-env\.mjs/);
    expect(calls[0].args).not.toContain('--exclude-tools');
    expect(calls[0].args).not.toContain('--no-builtin-tools');
    expect(calls[0].opts.env.COMMONLY_LITELLM_KEY).toBe('sk-real-provider-key');
  });

  test('assertSandboxSupported admits public, and still refuses a mode without public trust', () => {
    expect(() => assertSandboxSupported({ sandbox: { trust: 'public' } }, 'darwin')).not.toThrow();
    expect(() => assertSandboxSupported({}, 'linux')).not.toThrow();
    expect(() => assertSandboxSupported({ sandbox: { mode: 'workspace' } }, 'darwin')).toThrow(/cannot be enforced/);
  });
});

describe('the bridge registers only the tools a seat may have', () => {
  const tools = ['commonly_post_message', 'commonly_attach_file', 'commonly_catch_up', 'commonly_get_messages'].map((name) => ({ name }));
  test('withheld tools are dropped', () => {
    expect(registrableTools(tools, { withheldTools: PUBLIC_WITHHELD_TOOLS }).map((t) => t.name))
      .toEqual(['commonly_post_message', 'commonly_get_messages']);
  });
  test('a server with no withheld list keeps every tool (private seats)', () => {
    expect(registrableTools(tools, {})).toEqual(tools);
  });
});

// F197: a public seat's writable workspace is the scratch folder the CLI made,
// so the profile pins it. A link at that path refuses the turn before spawn.
test('a public seat whose writable workspace is a link is refused, and nothing is spawned', async () => {
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  await rm(workspace, { recursive: true });
  await symlink(elsewhere, workspace);
  const { impl, calls } = makeSpawnImpl();
  const error = await pi.spawn('hi', publicCtx({
    _spawnImpl: impl,
    _wrapArgvWithSeatbelt: (inner, opts) => { buildSeatbeltProfile(opts); return inner; },
  })).catch((err) => err);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toMatch(/its writable workspace/);
  expect(error.message).toContain(workspace);
  expect(calls).toHaveLength(0);
});

