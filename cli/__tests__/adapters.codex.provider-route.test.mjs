/**
 * adapters.codex.provider-route.test.mjs — D250 / TASK-786
 *
 * A public Codex seat starts with `--ignore-user-config`, so no config.toml
 * provider applies. F188 forwards OPENAI_BASE_URL with `-c openai_base_url`,
 * but the key then stays in codex's own environment. With CODEX_API_KEY in the
 * seat's environment, the key now stays on the host behind the per-turn
 * loopback proxy (the Claude seat's route, on the Responses wire), and codex
 * is handed only a `-c model_providers.*` entry naming the proxy and a
 * per-turn token.
 *
 * Measured before writing this (codex-cli 0.162.1, a stub upstream, dummy
 * token): with `--ignore-user-config`, `-c model_provider="<id>"` plus
 * `-c model_providers.<id>={base_url=…,env_key=…,wire_api="responses"}` sent
 * `POST /v1/responses` to the stub with `Authorization: Bearer <env_key value>`.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { createServer, request as httpRequest } from 'http';
import { lstat, mkdtemp, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

await jest.unstable_mockModule('child_process', () => ({
  spawnSync: jest.fn(),
  spawn: jest.fn(),
}));

const { default: codex } = await import('../src/lib/adapters/codex.js');

const REAL_KEY = 'sk-gateway-real-0123456789abcdefghij';
const PROXY_TOKEN = 'per-turn-proxy-token-0123456789abcdef';

const findOutputFile = (args) => {
  const idx = args.findIndex((a) => a === '-o');
  return idx === -1 ? null : args[idx + 1];
};

// A fake codex: `during` runs while the "process" is alive (the only moment
// the per-turn proxy and files exist), then it writes its reply and closes.
const makeSpawnImpl = ({ stdoutChunks = ['{"type":"thread.started","thread_id":"sid-1"}\n'], during = null } = {}) => {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    setTimeout(async () => {
      // A `during` that throws (no provider entry to read) is a failed turn,
      // not a hung one: the "process" exits 1 and the adapter rejects.
      let code = 0;
      try {
        if (during) await during(args, opts);
      } catch (err) {
        proc.stderr.emit('data', Buffer.from(String(err?.message || err)));
        code = 1;
      }
      for (const chunk of stdoutChunks) proc.stdout.emit('data', Buffer.from(chunk));
      await writeFile(findOutputFile(args), 'ok', 'utf8');
      proc.emit('close', code);
    }, 0);
    return proc;
  };
  return { impl, calls };
};

const cFlags = (args) => args.map((a, i) => (a === '-c' ? args[i + 1] : null)).filter(Boolean);

const providerEntry = (args) => cFlags(args).find((flag) => flag.startsWith('model_providers.'));

// Reads a `key="value"` pair out of the inline TOML table codex is handed.
const tomlField = (entry, key) => {
  const match = entry?.match(new RegExp(`${key}=("(?:[^"\\\\]|\\\\.)*")`));
  return match ? JSON.parse(match[1]) : null;
};

const publicSeat = async (env, extra = {}) => {
  const operatorHome = await mkdtemp(join(tmpdir(), 'commonly-codex-operator-home-'));
  const publicHome = await mkdtemp(join(tmpdir(), 'commonly-codex-public-home-'));
  return {
    sessionId: null,
    cwd: '/tmp/public-agent-workspace',
    environment: { model: 'claude-haiku-5-5', sandbox: { mode: 'workspace', trust: 'public' } },
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: operatorHome, ...env },
    agentName: 'gateway-test-agent',
    timeoutMs: 20_000,
    _publicCodexHome: publicHome,
    ...extra,
  };
};

const fakeProxy = (started, closed = []) => async (opts) => {
  started.push(opts);
  return {
    baseURL: 'http://127.0.0.1:41234/v1',
    port: 41234,
    token: PROXY_TOKEN,
    close: async () => { closed.push(true); },
  };
};

describe('codex adapter — a public seat on a provider gateway (D250)', () => {
  test('CODEX_API_KEY and OPENAI_BASE_URL start the Responses proxy, and codex gets only its address and token', async () => {
    const started = [];
    const closed = [];
    const { impl, calls } = makeSpawnImpl();
    const ctx = await publicSeat({
      CODEX_API_KEY: REAL_KEY,
      OPENAI_BASE_URL: 'https://gateway.example/v1',
      OPENAI_API_KEY: 'sk-openai-other-0123456789abcdef',
    }, { _startProviderProxy: fakeProxy(started, closed), _spawnImpl: impl });

    await codex.spawn('hello', ctx);

    expect(started).toEqual([{
      provider: { baseURL: 'https://gateway.example/v1' },
      keyMaterial: REAL_KEY,
      wire: 'openai-responses',
      adapterLabel: 'Codex',
    }]);
    const { args, opts } = calls[0];
    expect(args).toContain('--ignore-user-config');
    expect(cFlags(args)).toContain('model_provider="commonly_proxy"');
    const entry = providerEntry(args);
    expect(entry.startsWith('model_providers.commonly_proxy={')).toBe(true);
    expect(tomlField(entry, 'base_url')).toBe('http://127.0.0.1:41234/v1');
    expect(tomlField(entry, 'wire_api')).toBe('responses');
    const tokenEnv = tomlField(entry, 'env_key');
    expect(tokenEnv).toBe('COMMONLY_CODEX_PROVIDER_TOKEN');
    expect(opts.env[tokenEnv]).toBe(PROXY_TOKEN);
    // No provider key of any name reaches codex, and nothing in its argv or
    // environment carries the real key or names the gateway as its route.
    for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'LITELLM_API_KEY', 'LITELLM_MASTER_KEY']) {
      expect(opts.env).not.toHaveProperty(name);
    }
    expect(Object.values(opts.env)).not.toContain(REAL_KEY);
    expect(args.join('\n')).not.toContain(REAL_KEY);
    expect(args.join('\n')).not.toContain('gateway.example');
    // Model commands see only the shell allowlist, which never names the token.
    const include = cFlags(args).find((flag) => flag.startsWith('shell_environment_policy.include_only='));
    expect(JSON.parse(include.split('=').slice(1).join('='))).not.toContain(tokenEnv);
    expect(closed).toEqual([true]);
  });

  test('without OPENAI_BASE_URL the proxy fronts OpenAI itself', async () => {
    const started = [];
    const { impl } = makeSpawnImpl();
    await codex.spawn('hello', await publicSeat({ CODEX_API_KEY: REAL_KEY },
      { _startProviderProxy: fakeProxy(started), _spawnImpl: impl }));
    expect(started[0].provider).toEqual({ baseURL: 'https://api.openai.com/v1' });
  });

  test('a resumed turn routes through the proxy too', async () => {
    const started = [];
    const { impl, calls } = makeSpawnImpl();
    await codex.spawn('again', await publicSeat({ CODEX_API_KEY: REAL_KEY },
      { sessionId: 'sid-earlier', _startProviderProxy: fakeProxy(started), _spawnImpl: impl }));
    expect(calls[0].args.slice(0, 5)).toEqual(['--ask-for-approval', 'never', 'exec', 'resume', 'sid-earlier']);
    expect(cFlags(calls[0].args)).toContain('model_provider="commonly_proxy"');
    expect(started).toHaveLength(1);
  });

  test('with no key a public seat keeps the Codex login and starts no proxy', async () => {
    const started = [];
    const { impl, calls } = makeSpawnImpl();
    await codex.spawn('hello', await publicSeat({ OPENAI_BASE_URL: 'https://gateway.example/v1' },
      { _startProviderProxy: fakeProxy(started), _spawnImpl: impl }));
    expect(started).toEqual([]);
    expect(providerEntry(calls[0].args)).toBeUndefined();
    expect(cFlags(calls[0].args).some((flag) => flag.startsWith('model_provider='))).toBe(false);
  });

  test('OPENAI_API_KEY alone keeps the F188 route: the URL is forwarded and no proxy starts', async () => {
    const started = [];
    const { impl, calls } = makeSpawnImpl();
    await codex.spawn('hello', await publicSeat({
      OPENAI_API_KEY: REAL_KEY,
      OPENAI_BASE_URL: 'https://gateway.example/v1',
    }, { _startProviderProxy: fakeProxy(started), _spawnImpl: impl }));
    expect(started).toEqual([]);
    expect(cFlags(calls[0].args)).toContain('openai_base_url="https://gateway.example/v1"');
    expect(providerEntry(calls[0].args)).toBeUndefined();
  });

  test('the proxy route replaces the F188 flag, so the gateway URL never reaches codex', async () => {
    const { impl, calls } = makeSpawnImpl();
    await codex.spawn('hello', await publicSeat({
      CODEX_API_KEY: REAL_KEY,
      OPENAI_BASE_URL: 'https://gateway.example/v1',
    }, { _startProviderProxy: fakeProxy([]), _spawnImpl: impl }));
    expect(cFlags(calls[0].args).some((flag) => flag.startsWith('openai_base_url='))).toBe(false);
  });

  test('a host signed in with ChatGPT and holding CODEX_API_KEY sends the key to the gateway, never the session', async () => {
    const started = [];
    const seen = [];
    const { impl } = makeSpawnImpl({
      during: async (args, opts) => {
        seen.push(await lstat(join(opts.env.CODEX_HOME, 'auth.json')).catch((err) => err.code));
      },
    });
    const ctx = await publicSeat({
      CODEX_API_KEY: REAL_KEY,
      OPENAI_BASE_URL: 'https://gateway.example/v1',
    }, { _startProviderProxy: fakeProxy(started), _spawnImpl: impl });
    await writeFile(join(ctx.env.CODEX_HOME, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await codex.spawn('hello', ctx);
      expect(started).toHaveLength(1);
      expect(seen).toEqual(['ENOENT']);
      // F188's "ignored" line would be false here: the URL is in use.
      expect(stderr.mock.calls.flat().join('\n')).not.toContain('OPENAI_BASE_URL is ignored');
    } finally {
      stderr.mockRestore();
    }
  });

  test('none of the names codex or its gateway read stays in its environment on the proxy route', async () => {
    const { impl, calls } = makeSpawnImpl();
    await codex.spawn('hello', await publicSeat({
      CODEX_API_KEY: REAL_KEY,
      CODEX_ACCESS_TOKEN: 'access-token-0123456789abcdef',
      OPENAI_API_KEY: 'sk-openai-other-0123456789abcdef',
      LITELLM_API_KEY: 'sk-litellm-0123456789abcdef',
      OPENAI_BASE_URL: 'https://gateway.example/v1',
      // Windows env names are case-insensitive, so this one is the same variable.
      codex_api_key: REAL_KEY,
    }, { _startProviderProxy: fakeProxy([]), _spawnImpl: impl }));
    for (const name of ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'LITELLM_API_KEY', 'OPENAI_BASE_URL', 'codex_api_key']) {
      expect(calls[0].opts.env).not.toHaveProperty(name);
    }
  });

  test('a key pasted with a trailing newline reaches the proxy without it', async () => {
    const started = [];
    const { impl } = makeSpawnImpl();
    await codex.spawn('hello', await publicSeat({ CODEX_API_KEY: `${REAL_KEY}\n` },
      { _startProviderProxy: fakeProxy(started), _spawnImpl: impl }));
    expect(started[0].keyMaterial).toBe(REAL_KEY);
  });

  test('a failure tail is scrubbed of the trimmed key, not only the value as pasted', async () => {
    const { impl } = makeSpawnImpl({
      stdoutChunks: [
        '{"type":"thread.started","thread_id":"sid-1"}\n',
        `{"type":"turn.failed","error":{"message":"401 from gateway: bad key ${REAL_KEY} end"}}\n`,
      ],
    });
    const err = await codex.spawn('hello', await publicSeat({ CODEX_API_KEY: `${REAL_KEY}\n` },
      { _startProviderProxy: fakeProxy([]), _spawnImpl: impl })).catch((e) => e);
    expect(err.message).toContain('from gateway: bad key');
    expect(err.message).not.toContain(REAL_KEY);
  });

  test('a private seat is untouched: codex reads its own config, no proxy starts', async () => {
    const started = [];
    const { impl, calls } = makeSpawnImpl();
    await codex.spawn('hello', {
      environment: { model: 'gpt-test' },
      env: { PATH: process.env.PATH, CODEX_API_KEY: REAL_KEY, OPENAI_BASE_URL: 'https://gateway.example/v1' },
      _startProviderProxy: fakeProxy(started),
      _spawnImpl: impl,
    });
    expect(started).toEqual([]);
    expect(calls[0].args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(providerEntry(calls[0].args)).toBeUndefined();
  });

  test('a failed turn still closes the proxy, and its tail never echoes the key or the per-turn token', async () => {
    const closed = [];
    const { impl } = makeSpawnImpl({
      stdoutChunks: [
        '{"type":"thread.started","thread_id":"sid-1"}\n',
        `{"type":"turn.failed","error":{"message":"401 from gateway: bad key ${REAL_KEY} via ${PROXY_TOKEN}"}}\n`,
      ],
    });
    const err = await codex.spawn('hello', await publicSeat({ CODEX_API_KEY: REAL_KEY },
      { _startProviderProxy: fakeProxy([], closed), _spawnImpl: impl })).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('from gateway: bad key');
    expect(err.message).not.toContain(REAL_KEY);
    expect(err.message).not.toContain(PROXY_TOKEN);
    expect(closed).toEqual([true]);
  });

  test('a gateway URL carrying credentials is refused before the proxy or codex starts, and is not echoed', async () => {
    const started = [];
    const { impl, calls } = makeSpawnImpl();
    const ctx = await publicSeat({
      CODEX_API_KEY: REAL_KEY,
      OPENAI_BASE_URL: 'https://user:pass@gateway.example/v1',
    }, { _startProviderProxy: fakeProxy(started), _spawnImpl: impl });
    // A refused route changes nothing: the link an earlier turn left stays.
    const operatorAuth = join(ctx.env.CODEX_HOME, 'auth.json');
    await writeFile(operatorAuth, '{"test":true}', 'utf8');
    await symlink(operatorAuth, join(ctx._publicCodexHome, 'auth.json'));
    const err = await codex.spawn('hello', ctx).catch((e) => e);
    expect(err.message).toMatch(/OPENAI_BASE_URL must be a plain http\(s\) URL/);
    expect(err.message).not.toContain('user:pass');
    expect(started).toEqual([]);
    expect(calls).toEqual([]);
    expect((await lstat(join(ctx._publicCodexHome, 'auth.json'))).isSymbolicLink()).toBe(true);
  });

  test('end to end through the real proxy: the request codex would send reaches the gateway with the real key', async () => {
    const seen = [];
    const upstream = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      const gateway = `http://127.0.0.1:${upstream.address().port}/v1`;
      const statuses = [];
      // What codex does with its provider entry: POST <base_url>/responses
      // with `Authorization: Bearer $<env_key>`.
      const asCodexWould = (args, opts) => {
        const entry = providerEntry(args);
        const url = new URL(`${tomlField(entry, 'base_url')}/responses`);
        return new Promise((resolve, reject) => {
          const req = httpRequest({
            hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
            headers: { authorization: `Bearer ${opts.env[tomlField(entry, 'env_key')]}`, 'content-type': 'application/json' },
          }, (res) => { statuses.push(res.statusCode); res.resume(); res.on('end', resolve); });
          req.on('error', reject);
          req.end('{"model":"claude-haiku-5-5"}');
        });
      };
      const { impl } = makeSpawnImpl({ during: asCodexWould });
      await codex.spawn('hello', await publicSeat({ CODEX_API_KEY: REAL_KEY, OPENAI_BASE_URL: gateway },
        { _spawnImpl: impl }));
      expect(statuses).toEqual([200]);
      expect(seen).toEqual([{ method: 'POST', url: '/v1/responses', auth: `Bearer ${REAL_KEY}` }]);
    } finally {
      await new Promise((resolve) => upstream.close(resolve));
    }
  });

  test('a spawn aborted after the proxy started still closes it, and codex never runs', async () => {
    const closed = [];
    const { impl, calls } = makeSpawnImpl();
    const controller = new AbortController();
    controller.abort(new Error('stalled before spawn'));
    await expect(codex.spawn('hello', await publicSeat({ CODEX_API_KEY: REAL_KEY },
      { signal: controller.signal, _startProviderProxy: fakeProxy([], closed), _spawnImpl: impl })))
      .rejects.toThrow(/stalled before spawn/);
    expect(calls).toEqual([]);
    expect(closed).toEqual([true]);
  });

  test('on the proxy route the public home gets no link to the Codex login, and a stale one is removed', async () => {
    const { impl } = makeSpawnImpl();
    const ctx = await publicSeat({ CODEX_API_KEY: REAL_KEY }, { _startProviderProxy: fakeProxy([]), _spawnImpl: impl });
    const operatorAuth = join(ctx.env.CODEX_HOME, 'auth.json');
    await writeFile(operatorAuth, '{"test":true}', 'utf8');
    // Left by an earlier turn on the person's login.
    await symlink(operatorAuth, join(ctx._publicCodexHome, 'auth.json'));
    await codex.spawn('hello', ctx);
    await expect(lstat(join(ctx._publicCodexHome, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
