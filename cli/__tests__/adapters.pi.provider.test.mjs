/**
 * adapters.pi.provider.test.mjs — pi takes the shared provider shape.
 *
 * `{ id, baseURL, keyFile, models, api }` is what opencode, qwen, goose and dsh
 * accept in `--env`. pi has a second shape of its own (`{ name, baseUrl, api,
 * apiKeyEnv }`, a token-file override), and both have to work: the shared one
 * validated and keyed from `keyFile`, pi's own left as it was.
 *
 * What these guard is where the key goes. A private turn gets it in pi's
 * environment under a name its shells never see; a public turn never gets it
 * at all, because the proxy in this process holds it. models.json only ever
 * holds an env reference. The real `pi` is not run: `_spawnImpl` replaces the
 * spawn, and the real-kernel half lives in adapters.pi.seatbelt.smoke.test.mjs.
 */
import { EventEmitter } from 'events';
import { createServer } from 'http';
import {
  chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile,
} from 'fs/promises';
import { Writable } from 'stream';
import { tmpdir } from 'os';
import { join } from 'path';
import pi, { TESTED_PI_VERSIONS, resolveProvider, seatHome } from '../src/lib/adapters/pi.js';
import { getAdapter, providerKeyEnvNames } from '../src/lib/adapters/index.js';
import { providerRefusal } from '../src/lib/environment.js';

const event = (obj) => `${JSON.stringify(obj)}\n`;
const assistant = (text) => event({
  type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] },
}) + event({ type: 'agent_end' });

const fakeChild = ({ stdout = '', stderr = '', code = 0, onSpawn } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  const fd3 = new Writable({ write(_chunk, _enc, done) { done(); } });
  fd3.on('error', () => {});
  proc.stdio = [null, proc.stdout, proc.stderr, fd3];
  proc.kill = () => {};
  setTimeout(async () => {
    if (onSpawn) await onSpawn();
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', code);
  }, 5);
  return proc;
};
const makeSpawnImpl = (out = { stdout: assistant('ok') }) => {
  const calls = [];
  const impl = (cmd, args, opts) => { const proc = fakeChild(out); calls.push({ cmd, args, opts }); return proc; };
  return { impl, calls };
};

const SECRET = 'fake-owner-provider-key-0123456789';

let root;
let home;
let workspace;
let keyFile;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-provider-')));
  home = join(root, 'pi-home');
  workspace = join(root, 'workspace');
  await mkdir(workspace);
  await mkdir(join(root, 'keys'));
  keyFile = join(root, 'keys', 'provider.key');
  await writeFile(keyFile, `${SECRET}\n`, { mode: 0o600 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const shared = (over = {}) => ({
  id: 'owner', baseURL: 'https://models.example/v1', keyFile, ...over,
});
const privateCtx = (over = {}) => ({
  cwd: workspace,
  agentName: 'kai',
  env: { PATH: '/usr/bin' },
  environment: { model: 'owner-model', provider: shared() },
  _piHome: home,
  ...over,
});
const modelsJson = async (dir = home) => JSON.parse(await readFile(join(dir, 'agent', 'models.json'), 'utf8'));

/** Every file under a directory, for "the secret is on no disk the seat owns". */
const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  }));
  return nested.flat();
};

describe('what pi declares', () => {
  test('both shared APIs, each verified against pi 0.84.1 (docs/agents/pi-adapter.md)', () => {
    expect(pi.supportsProvider).toBe(true);
    expect(pi.providerApis).toEqual(['openai-chat', 'anthropic-messages']);
  });

  test('the one gate config, attach, run and the daemon swap share accepts the shared shape', () => {
    const adapter = getAdapter('pi');
    expect(providerRefusal({ model: 'm', provider: shared() }, adapter)).toBeNull();
    expect(providerRefusal({ model: 'm', provider: shared({ api: 'openai-chat' }) }, adapter)).toBeNull();
    expect(providerRefusal({ model: 'm', provider: shared({ api: 'anthropic-messages' }) }, adapter)).toBeNull();
  });

  test('that gate still refuses an api the shared shape does not name', () => {
    expect(providerRefusal({ model: 'm', provider: shared({ api: 'google-generative-ai' }) }, getAdapter('pi')))
      .toMatch(/cannot use provider\.api "google-generative-ai"/);
  });

  test('pi\'s own token-file shape is not judged by the shared api list', () => {
    const provider = {
      name: 'litellm', baseUrl: 'http://litellm:4000/v1', api: 'openai-completions', apiKeyEnv: 'COMMONLY_LITELLM_KEY',
    };
    expect(providerRefusal({ model: 'm', provider }, getAdapter('pi'))).toBeNull();
    // Only pi is taught this. The same block on another adapter stays refused.
    expect(providerRefusal({ model: 'm', provider }, getAdapter('goose'))).toMatch(/cannot use provider\.api/);
  });

  test('the proxy a public turn uses does not pin Anthropic Messages, so that pair is refused at the gate', () => {
    const environment = {
      model: 'm', sandbox: { trust: 'public' }, provider: shared({ api: 'anthropic-messages' }),
    };
    expect(providerRefusal(environment, getAdapter('pi'))).toMatch(/public seat/);
    expect(providerRefusal({ ...environment, sandbox: { trust: 'internal' } }, getAdapter('pi'))).toMatch(/public seat/);
    expect(providerRefusal({ ...environment, provider: shared() }, getAdapter('pi'))).toBeNull();
  });

  test('the daemon still carries COMMONLY_LITELLM_KEY for the seats that use it', () => {
    expect(pi.providerKeyEnv).toBe('COMMONLY_LITELLM_KEY');
    expect(providerKeyEnvNames()).toContain('COMMONLY_LITELLM_KEY');
  });
});

describe('validateEnvironment', () => {
  const environment = (provider) => ({ model: 'owner-model', provider });

  test('resolves the key file and reads nothing else', async () => {
    await expect(pi.validateEnvironment(environment(shared()), workspace)).resolves.toBe(keyFile);
  });

  test('a seat with no provider, and pi\'s own shape, need no key file', async () => {
    await expect(pi.validateEnvironment({ model: 'm' })).resolves.toBeNull();
    await expect(pi.validateEnvironment(environment({ name: 'x', baseUrl: 'https://x.example/v1', apiKeyEnv: 'X' })))
      .resolves.toBeNull();
  });

  test('a key file must be private, regular and outside the workspace', async () => {
    await chmod(keyFile, 0o644);
    await expect(pi.validateEnvironment(environment(shared()), workspace)).rejects.toThrow(/mode 0600/);
    await chmod(keyFile, 0o600);
    const link = join(root, 'keys', 'link.key');
    await symlink(keyFile, link);
    await expect(pi.validateEnvironment(environment(shared({ keyFile: link })), workspace))
      .rejects.toThrow(/non-symlink/);
    const inside = join(workspace, 'provider.key');
    await writeFile(inside, SECRET, { mode: 0o600 });
    await expect(pi.validateEnvironment(environment(shared({ keyFile: inside })), workspace))
      .rejects.toThrow(/outside the workspace/);
  });

  test('a block that mixes the two shapes is refused, not half-read', async () => {
    await expect(pi.validateEnvironment(environment({ ...shared(), apiKeyEnv: 'OTHER_KEY' }), workspace))
      .rejects.toThrow(/unknown provider key: "apiKeyEnv"/);
    await expect(pi.validateEnvironment(environment({ name: 'x', baseUrl: 'https://x.example/v1', keyFile }), workspace))
      .rejects.toThrow(/provider\.id/);
  });
});

describe('a private turn with its own provider', () => {
  test('models.json maps id, baseURL and api, and holds an env reference, not the key', async () => {
    const { impl, calls } = makeSpawnImpl();
    await pi.spawn('hi', privateCtx({ _spawnImpl: impl }));
    expect(calls[0].args).toEqual(expect.arrayContaining(['--provider', 'owner', '--model', 'owner-model']));
    const { providers } = await modelsJson();
    expect(Object.keys(providers)).toEqual(['owner']);
    expect(providers.owner).toMatchObject({
      name: 'owner',
      baseUrl: 'https://models.example/v1',
      api: 'openai-completions',
      apiKey: '$COMMONLY_PI_PROVIDER_KEY',
    });
    expect(providers.owner.models[0].id).toBe('owner-model');
  });

  test('anthropic-messages keeps its name: pi and the shared shape use the same word', async () => {
    const { impl } = makeSpawnImpl();
    await pi.spawn('hi', privateCtx({
      _spawnImpl: impl,
      environment: { model: 'owner-model', provider: shared({ api: 'anthropic-messages', baseURL: 'https://models.example' }) },
    }));
    expect((await modelsJson()).providers.owner).toMatchObject({ api: 'anthropic-messages', baseUrl: 'https://models.example' });
  });

  // pi sends reasoning_effort for a reasoning model, and a provider that doesn't
  // know the field refuses the call. The shared shape can't say effort: none, so
  // this is how an owner turns it off.
  test('provider.models marks a model that does not reason; the default stays on', async () => {
    const { impl } = makeSpawnImpl();
    await pi.spawn('hi', privateCtx({
      _spawnImpl: impl,
      environment: { model: 'owner-model', provider: shared({ models: { 'owner-model': { reasoning: false } } }) },
    }));
    expect((await modelsJson()).providers.owner.models[0].reasoning).toBe(false);
    await pi.spawn('hi', privateCtx({ _spawnImpl: impl }));
    expect((await modelsJson()).providers.owner.models[0].reasoning).toBe(true);
  });

  test('the key from keyFile reaches pi, and needs no COMMONLY_LITELLM_KEY', async () => {
    const { impl, calls } = makeSpawnImpl();
    await expect(pi.spawn('hi', privateCtx({ _spawnImpl: impl }))).resolves.toMatchObject({ text: 'ok' });
    expect(calls[0].opts.env.COMMONLY_PI_PROVIDER_KEY).toBe(SECRET);
    // The name goes in so the always-loaded extension strips it from shells.
    expect(calls[0].opts.env.COMMONLY_PI_PROVIDER_KEY_ENV).toBe('COMMONLY_PI_PROVIDER_KEY');
  });

  test('a seat with its own key does not carry the LiteLLM key into pi', async () => {
    const { impl, calls } = makeSpawnImpl();
    await pi.spawn('hi', privateCtx({ _spawnImpl: impl, env: { PATH: '/usr/bin', COMMONLY_LITELLM_KEY: 'sk-unrelated' } }));
    expect(calls[0].opts.env.COMMONLY_LITELLM_KEY).toBeUndefined();
  });

  test('the key is in no file the seat owns', async () => {
    const { impl } = makeSpawnImpl();
    await pi.spawn('hi', privateCtx({ _spawnImpl: impl }));
    const files = await walk(home);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(await readFile(file, 'utf8')).not.toContain(SECRET);
  });

  test('a turn that fails does not print the key', async () => {
    const { impl } = makeSpawnImpl({
      stdout: event({
        type: 'message_end', message: { role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: 'partial' }] },
      }),
      stderr: `upstream echoed Authorization: Bearer ${SECRET}\n`,
      code: 1,
    });
    const failure = await pi.spawn('hi', privateCtx({ _spawnImpl: impl })).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).not.toContain(SECRET);
  });

  test('an empty key file is refused by name before pi starts', async () => {
    await writeFile(keyFile, '  \n', { mode: 0o600 });
    const { impl, calls } = makeSpawnImpl();
    await expect(pi.spawn('hi', privateCtx({ _spawnImpl: impl }))).rejects.toThrow(/provider\.keyFile must not be empty/);
    expect(calls).toHaveLength(0);
  });

  test('a seat with no provider still refuses without the LiteLLM key', async () => {
    const { impl } = makeSpawnImpl();
    await expect(pi.spawn('hi', privateCtx({ _spawnImpl: impl, environment: { model: 'm' } })))
      .rejects.toThrow(/COMMONLY_LITELLM_KEY is not set/);
  });
});

describe('pi\'s own token-file shape keeps working', () => {
  test('its key still comes from the named variable and reads through the same mapping', async () => {
    const provider = { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DS_KEY' };
    expect(resolveProvider({ provider })).toEqual({
      name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions', apiKeyEnv: 'DS_KEY',
    });
    const { impl, calls } = makeSpawnImpl();
    await pi.spawn('hi', privateCtx({
      _spawnImpl: impl, env: { PATH: '/usr/bin', DS_KEY: 'k' }, environment: { model: 'm', provider },
    }));
    expect((await modelsJson()).providers.deepseek.apiKey).toBe('$DS_KEY');
    expect(calls[0].opts.env.DS_KEY).toBe('k');
    expect(calls[0].opts.env.COMMONLY_PI_PROVIDER_KEY).toBeUndefined();
  });

  test('and it still refuses when that variable is unset', async () => {
    const { impl } = makeSpawnImpl();
    await expect(pi.spawn('hi', privateCtx({
      _spawnImpl: impl,
      environment: { model: 'm', provider: { name: 'x', baseUrl: 'https://x.example/v1', apiKeyEnv: 'DS_KEY' } },
    }))).rejects.toThrow(/DS_KEY is not set/);
  });
});

describe('a public turn with its own provider', () => {
  let binDir;
  let packageRoot;
  beforeEach(async () => {
    packageRoot = join(root, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
    binDir = join(root, 'bin');
    await Promise.all([mkdir(join(packageRoot, 'dist'), { recursive: true }), mkdir(binDir)]);
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
    await writeFile(join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
    await symlink(join(packageRoot, 'dist', 'cli.js'), join(binDir, 'pi'));
  });

  const publicCtx = (over = {}) => ({
    cwd: workspace,
    agentName: 'kai-public',
    instanceUrl: 'https://api.example',
    env: { PATH: `${binDir}:/usr/bin`, OPERATOR_SECRET: 'do-not-leak' },
    environment: {
      model: 'owner-model',
      sandbox: { trust: 'public' },
      provider: shared(),
    },
    _piHome: home,
    _platform: 'darwin',
    _version: TESTED_PI_VERSIONS[0],
    ...over,
  });
  const captureWrap = () => {
    const seen = [];
    const wrap = (inner, opts) => { seen.push({ inner, opts }); return ['/usr/bin/sandbox-exec', '-p', '(version 1)', ...inner]; };
    return { wrap, seen };
  };
  const publicHome = () => seatHome({ _piHome: home }, { publicSeat: true });

  test('the jailed pi holds the proxy\'s token, never the key', async () => {
    const { impl, calls } = makeSpawnImpl();
    const { wrap } = captureWrap();
    await pi.spawn('hi', publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: wrap }));
    const { env } = calls[0].opts;
    expect(env.COMMONLY_PI_PROVIDER_KEY).toEqual(expect.any(String));
    expect(env.COMMONLY_PI_PROVIDER_KEY).not.toBe(SECRET);
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(env.OPERATOR_SECRET).toBeUndefined();
    expect(JSON.stringify(calls[0].args)).not.toContain(SECRET);
  });

  test('models.json points at loopback, and no path into the jail names the key file', async () => {
    const { impl } = makeSpawnImpl();
    const { wrap, seen } = captureWrap();
    await pi.spawn('hi', publicCtx({ _spawnImpl: impl, _wrapArgvWithSeatbelt: wrap }));
    const { owner } = (await modelsJson(publicHome())).providers;
    expect(owner.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1/);
    expect(owner.apiKey).toBe('$COMMONLY_PI_PROVIDER_KEY');
    const { opts } = seen[0];
    expect(opts.loopbackNetworkPorts).toEqual([Number(new URL(owner.baseUrl).port)]);
    expect(opts.network).toBeUndefined();
    expect(JSON.stringify(opts)).not.toContain(keyFile);
    expect(JSON.stringify(opts)).not.toContain(join(root, 'keys'));
    for (const file of await walk(publicHome())) expect(await readFile(file, 'utf8')).not.toContain(SECRET);
  });

  test('the proxy reads keyFile in this process and sends the real key upstream', async () => {
    const seen = [];
    const upstream = createServer((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization });
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'owner-model', choices: [] }));
      });
    });
    await new Promise((resolve) => { upstream.listen(0, '127.0.0.1', resolve); });
    try {
      const baseURL = `http://127.0.0.1:${upstream.address().port}/v1`;
      let reply;
      const impl = (cmd, args, opts) => fakeChild({
        stdout: assistant('ok'),
        onSpawn: async () => {
          const models = await modelsJson(publicHome());
          const response = await fetch(`${models.providers.owner.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${opts.env.COMMONLY_PI_PROVIDER_KEY}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'owner-model', messages: [] }),
          });
          reply = { status: response.status, body: await response.text() };
        },
      });
      const { wrap } = captureWrap();
      await pi.spawn('hi', publicCtx({
        _spawnImpl: impl,
        _wrapArgvWithSeatbelt: wrap,
        environment: { model: 'owner-model', sandbox: { trust: 'public' }, provider: shared({ baseURL }) },
      }));
      expect(reply.status).toBe(200);
      expect(seen).toEqual([{ url: '/v1/chat/completions', authorization: `Bearer ${SECRET}` }]);
    } finally {
      await new Promise((resolve) => { upstream.close(resolve); });
    }
  });

  test('a key file the jail could read is refused, so the home cannot hold it', async () => {
    const publicDir = publicHome();
    await mkdir(publicDir, { recursive: true });
    const inHome = join(publicDir, 'provider.key');
    await writeFile(inHome, SECRET, { mode: 0o600 });
    const { impl, calls } = makeSpawnImpl();
    const { wrap } = captureWrap();
    await expect(pi.spawn('hi', publicCtx({
      _spawnImpl: impl,
      _wrapArgvWithSeatbelt: wrap,
      environment: { model: 'owner-model', sandbox: { trust: 'public' }, provider: shared({ keyFile: inHome }) },
    }))).rejects.toThrow(/keyFile .*inside the sandbox/);
    expect(calls).toHaveLength(0);
  });

  test('Anthropic Messages is refused before pi starts', async () => {
    const { impl, calls } = makeSpawnImpl();
    await expect(pi.spawn('hi', publicCtx({
      _spawnImpl: impl,
      environment: { model: 'owner-model', sandbox: { trust: 'public' }, provider: shared({ api: 'anthropic-messages' }) },
    }))).rejects.toThrow(/public seat/);
    expect(calls).toHaveLength(0);
  });

  test('a public key file is not widened: mode 0644 is refused too', async () => {
    await chmod(keyFile, 0o644);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o644);
    const { impl, calls } = makeSpawnImpl();
    await expect(pi.spawn('hi', publicCtx({ _spawnImpl: impl }))).rejects.toThrow(/mode 0600/);
    expect(calls).toHaveLength(0);
  });
});
