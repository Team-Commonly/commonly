/**
 * How the codex and claude adapters point their CLI at the supervisor's
 * provider relay (ctx.providerRelay), and when they report a CLI as not
 * covered instead. The relay itself is tested in packages/seats; here the relay
 * is a recording double, and the CLIs are `_spawnImpl` fakes.
 */
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

await jest.unstable_mockModule('child_process', () => ({
  spawnSync: jest.fn(() => ({ status: 1 })),
  spawn: jest.fn(),
}));

const codex = (await import('../src/lib/adapters/codex.js')).default;
const claude = (await import('../src/lib/adapters/claude.js')).default;
const { codexProviderRoute, readCodexConfigSubset, routeCodexThroughRelay } = await import('../src/lib/adapters/codex-provider-route.js');
const { claudeProviderRoute, routeClaudeThroughRelay } = await import('../src/lib/adapters/claude-provider-route.js');

const RELAY_BASE = 'http://127.0.0.1:41234/tok';

/** A relay handle that records what an adapter asked of it. */
const recordingRelay = () => {
  const relay = {
    bound: [],
    notCoveredReasons: [],
    bind({ upstream }) {
      relay.bound.push(upstream);
      return `${RELAY_BASE}${new URL(upstream).pathname.replace(/\/+$/, '')}`;
    },
    notCovered(reason) { relay.notCoveredReasons.push(reason); },
  };
  return relay;
};

const homes = [];
const codexHome = ({ config = null, auth = null } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-relay-route-'));
  homes.push(dir);
  if (config !== null) writeFileSync(join(dir, 'config.toml'), config);
  if (auth !== null) writeFileSync(join(dir, 'auth.json'), JSON.stringify(auth));
  return dir;
};
afterAll(() => { for (const dir of homes) rmSync(dir, { recursive: true, force: true }); });

describe('codexProviderRoute (codex 0.162 provider resolution)', () => {
  test('the built-in openai provider is pointed with openai_base_url, never model_providers.openai', () => {
    const route = codexProviderRoute({ env: { CODEX_HOME: codexHome(), CODEX_API_KEY: 'k' } });
    expect(route).toMatchObject({ covered: true, provider: 'openai', upstream: 'https://api.openai.com/v1' });
    expect(route.flags(`${RELAY_BASE}/v1`)).toEqual(['-c', `openai_base_url="${RELAY_BASE}/v1"`]);
  });

  test('the auth mode picks the upstream: ChatGPT sign-in goes to the Codex backend, an API key to the API', () => {
    const chatgpt = codexProviderRoute({ env: { CODEX_HOME: codexHome({ auth: { auth_mode: 'chatgpt', tokens: { id_token: 'x' } } }) } });
    expect(chatgpt.upstream).toBe('https://chatgpt.com/backend-api/codex');
    const apikey = codexProviderRoute({ env: { CODEX_HOME: codexHome({ auth: { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' } }) } });
    expect(apikey.upstream).toBe('https://api.openai.com/v1');
    const legacyKey = codexProviderRoute({ env: { CODEX_HOME: codexHome({ auth: { OPENAI_API_KEY: 'sk-x' } }) } });
    expect(legacyKey.upstream).toBe('https://api.openai.com/v1');
    const legacyTokens = codexProviderRoute({ env: { CODEX_HOME: codexHome({ auth: { tokens: { id_token: 'x' } } }) } });
    expect(legacyTokens.upstream).toBe('https://chatgpt.com/backend-api/codex');
  });

  test('an unknown, unreadable or ambiguous auth mode is not covered rather than guessed', () => {
    expect(codexProviderRoute({ env: { CODEX_HOME: codexHome() } })).toMatchObject({ covered: false, reason: expect.stringMatching(/auth\.json/) });
    expect(codexProviderRoute({ env: { CODEX_HOME: codexHome({ auth: { auth_mode: 'bedrockApiKey' } }) } }).covered).toBe(false);
    expect(codexProviderRoute({ env: { CODEX_HOME: codexHome({ auth: { OPENAI_API_KEY: 'k', tokens: {} } }) } }).covered).toBe(false);
  });

  test('a configured openai_base_url is the upstream, and a profile can name the provider', () => {
    const configured = codexProviderRoute({ env: { CODEX_HOME: codexHome({ config: 'openai_base_url = "https://proxy.example/v1"\n' }) } });
    expect(configured).toMatchObject({ covered: true, upstream: 'https://proxy.example/v1' });
    const profiled = codexProviderRoute({
      env: {
        CODEX_HOME: codexHome({
          config: [
            'profile = "work"',
            'model_provider = "openai"',
            '[profiles.work]',
            'model_provider = "corp"',
            '[model_providers."corp"]',
            'base_url = "https://llm.corp.example/v1" # inline comment',
          ].join('\n'),
        }),
      },
    });
    expect(profiled).toMatchObject({ covered: true, provider: 'corp', upstream: 'https://llm.corp.example/v1' });
    expect(profiled.flags(`${RELAY_BASE}/v1`)).toEqual(['-c', `model_providers.corp.base_url="${RELAY_BASE}/v1"`]);
  });

  test('other built-ins, AWS-signed and base-URL-less providers are not covered', () => {
    for (const id of ['amazon-bedrock', 'ollama', 'lmstudio']) {
      expect(codexProviderRoute({ env: { CODEX_HOME: codexHome({ config: `model_provider = "${id}"\n` }) } }))
        .toMatchObject({ covered: false, reason: expect.stringContaining(id) });
    }
    const aws = codexProviderRoute({
      env: { CODEX_HOME: codexHome({ config: 'model_provider = "b"\n[model_providers.b]\nbase_url = "https://x/v1"\n[model_providers.b.aws]\nregion = "us-east-1"\n' }) },
    });
    expect(aws).toMatchObject({ covered: false, reason: expect.stringMatching(/AWS/) });
    const bare = codexProviderRoute({ env: { CODEX_HOME: codexHome({ config: 'model_provider = "c"\n[model_providers.c]\nname = "c"\n' }) } });
    expect(bare).toMatchObject({ covered: false, reason: expect.stringMatching(/no base_url/) });
  });

  test('a config the reader cannot read safely is not covered', () => {
    const multiline = codexProviderRoute({ env: { CODEX_HOME: codexHome({ config: 'notes = """\nmodel_provider = "x"\n"""\n' }) } });
    expect(multiline).toMatchObject({ covered: false, reason: expect.stringMatching(/multi-line/) });
    const badId = codexProviderRoute({ env: { CODEX_HOME: codexHome({ config: 'model_provider = "a b"\n' }) } });
    expect(badId.covered).toBe(false);
  });

  test('--ignore-user-config seats resolve as codex does: the config file is not read', () => {
    const home = codexHome({ config: 'model_provider = "corp"\n[model_providers.corp]\nbase_url = "https://corp/v1"\n', auth: { auth_mode: 'chatgpt', tokens: {} } });
    expect(codexProviderRoute({ env: { CODEX_HOME: home }, ignoreUserConfig: true }))
      .toMatchObject({ covered: true, provider: 'openai', upstream: 'https://chatgpt.com/backend-api/codex' });
  });

  test('readCodexConfigSubset reads tables, dotted and quoted keys, and skips arrays', () => {
    expect(readCodexConfigSubset([
      'model = "gpt-5"',
      'tags = ["a", "b"]',
      'model_providers.x.base_url = "https://x/v1"',
      "[model_providers.'y']",
      "base_url = 'https://y/v1'",
    ].join('\n'))).toEqual({
      model: 'gpt-5',
      model_providers: { x: { base_url: 'https://x/v1' }, y: { base_url: 'https://y/v1' } },
    });
  });

  test('routeCodexThroughRelay binds the upstream, or reports why not; no relay, no flags', () => {
    const relay = recordingRelay();
    expect(routeCodexThroughRelay({ relay, env: { CODEX_HOME: codexHome(), CODEX_API_KEY: 'k' } }))
      .toEqual(['-c', `openai_base_url="${RELAY_BASE}/v1"`]);
    expect(relay.bound).toEqual(['https://api.openai.com/v1']);
    const refused = recordingRelay();
    expect(routeCodexThroughRelay({ relay: refused, env: { CODEX_HOME: codexHome({ config: 'model_provider = "ollama"\n' }) } })).toEqual([]);
    expect(refused.notCoveredReasons).toHaveLength(1);
    expect(refused.bound).toEqual([]);
    expect(routeCodexThroughRelay({ relay: null, env: {} })).toEqual([]);
  });
});

describe('codex adapter with ctx.providerRelay', () => {
  const fakeCodex = () => {
    const calls = [];
    const impl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = jest.fn();
      setTimeout(async () => {
        proc.stdout.emit('data', Buffer.from('{"type":"thread.started","thread_id":"t-1"}\n'));
        await writeFile(args[args.indexOf('-o') + 1], 'ok', 'utf8');
        proc.emit('close', 0);
      }, 0);
      return proc;
    };
    return { impl, calls };
  };

  test('the relay flag is added after the MCP flags and nothing else in the argv changes', async () => {
    const env = { ...process.env, CODEX_HOME: codexHome(), CODEX_API_KEY: 'k' };
    const plain = fakeCodex();
    await codex.spawn('hi', { environment: { model: 'm' }, env, _spawnImpl: plain.impl });
    const relayed = fakeCodex();
    const relay = recordingRelay();
    await codex.spawn('hi', { environment: { model: 'm' }, env, providerRelay: relay, _spawnImpl: relayed.impl });

    const strip = (args) => args.map((a) => (a.includes('commonly-codex-') ? '<out>' : a));
    const flag = `openai_base_url="${RELAY_BASE}/v1"`;
    const at = relayed.calls[0].args.indexOf(flag);
    expect(at).toBeGreaterThan(0);
    expect(relayed.calls[0].args[at - 1]).toBe('-c');
    const withoutFlag = [...relayed.calls[0].args.slice(0, at - 1), ...relayed.calls[0].args.slice(at + 1)];
    expect(strip(withoutFlag)).toEqual(strip(plain.calls[0].args));
    expect(plain.calls[0].args.some((a) => /base_url/.test(a))).toBe(false);
  });

  test('a provider codex cannot be pointed for is reported, and spawned exactly as without a relay', async () => {
    const env = { ...process.env, CODEX_HOME: codexHome({ config: 'model_provider = "amazon-bedrock"\n' }) };
    const plain = fakeCodex();
    await codex.spawn('hi', { environment: { model: 'm' }, env, _spawnImpl: plain.impl });
    const relayed = fakeCodex();
    const relay = recordingRelay();
    await codex.spawn('hi', { environment: { model: 'm' }, env, providerRelay: relay, _spawnImpl: relayed.impl });
    expect(relay.notCoveredReasons).toEqual([expect.stringContaining('amazon-bedrock')]);
    const strip = (args) => args.map((a) => (a.includes('commonly-codex-') ? '<out>' : a));
    expect(strip(relayed.calls[0].args)).toEqual(strip(plain.calls[0].args));
  });
});

describe('claudeProviderRoute and the claude adapter', () => {
  test('ANTHROPIC_BASE_URL is the upstream when set, api.anthropic.com otherwise', () => {
    expect(claudeProviderRoute({ env: {} })).toEqual({ covered: true, upstream: 'https://api.anthropic.com' });
    expect(claudeProviderRoute({ env: { ANTHROPIC_BASE_URL: 'https://gw.example/anthropic' } }))
      .toEqual({ covered: true, upstream: 'https://gw.example/anthropic' });
  });

  test('Bedrock, Vertex and Foundry routes, and bwrap with a restricted network, are not covered', () => {
    for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
      expect(claudeProviderRoute({ env: { [name]: '1' } })).toMatchObject({ covered: false, reason: expect.stringContaining(name) });
      expect(claudeProviderRoute({ env: { [name]: '0' } }).covered).toBe(true);
    }
    const restricted = { sandbox: { mode: 'bwrap', network: { policy: 'restricted' } } };
    expect(claudeProviderRoute({ env: {}, environment: restricted })).toMatchObject({ covered: false, reason: expect.stringMatching(/bwrap/) });
    const shared = { sandbox: { mode: 'bwrap', network: { policy: 'unrestricted' } } };
    expect(claudeProviderRoute({ env: {}, environment: shared }).covered).toBe(true);
  });

  test('routeClaudeThroughRelay sets ANTHROPIC_BASE_URL to the relay; without a relay it touches nothing', () => {
    const relay = recordingRelay();
    const env = { ANTHROPIC_BASE_URL: 'https://gw.example/anthropic' };
    routeClaudeThroughRelay({ relay, claudeEnv: env });
    expect(relay.bound).toEqual(['https://gw.example/anthropic']);
    expect(env.ANTHROPIC_BASE_URL).toBe(`${RELAY_BASE}/anthropic`);
    const untouched = { PATH: '/bin' };
    routeClaudeThroughRelay({ relay: null, claudeEnv: untouched });
    expect(untouched).toEqual({ PATH: '/bin' });
  });

  const fakeClaude = (first = { stdout: 'ok\n', code: 0 }) => {
    const calls = [];
    const impl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const result = calls.length === 1 ? first : { stdout: 'recovered\n', code: 0 };
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = jest.fn();
      setTimeout(() => {
        if (result.stdout) proc.stdout.emit('data', Buffer.from(result.stdout));
        if (result.stderr) proc.stderr.emit('data', Buffer.from(result.stderr));
        proc.emit('close', result.code);
      }, 0);
      return proc;
    };
    return { impl, calls };
  };

  test('the claude child gets the relay as ANTHROPIC_BASE_URL, on the first spawn and on the session-recovery retry', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-relay-claude-'));
    homes.push(home);
    mkdirSync(join(home, '.claude'), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: home };
    const relay = recordingRelay();
    const { impl, calls } = fakeClaude({ stderr: 'Error: Session ID abc is already in use.', code: 1 });
    await claude.spawn('hi', { environment: { model: 'm' }, env, sessionId: 'abc', providerRelay: relay, _spawnImpl: impl });
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.opts.env.ANTHROPIC_BASE_URL).toBe(RELAY_BASE);
    expect(relay.bound).toEqual(['https://api.anthropic.com', 'https://api.anthropic.com']);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();

    const plain = fakeClaude();
    await claude.spawn('hi', { environment: { model: 'm' }, env, _spawnImpl: plain.impl });
    expect(plain.calls[0].opts.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
