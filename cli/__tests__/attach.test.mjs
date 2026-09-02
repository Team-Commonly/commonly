/**
 * attach.test.mjs — ADR-005 Phase 1a
 *
 * Covers the pure attach core + the token-file persistence helpers.
 * - performAttach:   detect → publish → install → mint runtime token
 * - saveAgentToken / loadAgentToken:  ~/.commonly/tokens/<name>.json round trip
 *
 * We stub `homedir` so all token writes land in a throwaway temp dir, and pass
 * a hand-rolled `client` with jest.fn() for get/post — no HTTP.
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tokensTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-attach-test-'));

await jest.unstable_mockModule('os', () => {
  const actual = os;
  return {
    ...actual,
    default: { ...actual, homedir: () => tokensTmpDir },
    homedir: () => tokensTmpDir,
  };
});

const {
  performAttach,
  setWakeOnMessage,
  saveAgentToken,
  loadAgentToken,
  buildDefaultEnvironment,
  bootstrapAgentRecordFromEnv,
} = await import('../src/commands/agent.js');

describe('setWakeOnMessage', () => {
  const record = {
    agentName: 'juno', podId: 'pod-9', instanceId: 'default', runtimeToken: 'cm_agent_j',
  };

  test('PATCHes the installation config through the registry route', async () => {
    const client = { patch: jest.fn(async () => ({ success: true })) };
    const result = await setWakeOnMessage({ client, record, enabled: true });
    expect(client.patch).toHaveBeenCalledWith(
      '/api/registry/pods/pod-9/agents/juno',
      { instanceId: 'default', config: { wakeOnMessage: { enabled: true } } },
    );
    expect(result).toEqual({
      agentName: 'juno', podId: 'pod-9', instanceId: 'default', enabled: true,
    });
  });

  test('off sends enabled:false (not a delete) so the read side sees an explicit value', async () => {
    const client = { patch: jest.fn(async () => ({ success: true })) };
    await setWakeOnMessage({ client, record, enabled: false });
    expect(client.patch.mock.calls[0][1].config.wakeOnMessage).toEqual({ enabled: false });
  });

  test('refuses a token record without a pod', async () => {
    const client = { patch: jest.fn() };
    await expect(setWakeOnMessage({ client, record: { agentName: 'x' }, enabled: true }))
      .rejects.toThrow(/podId/);
    expect(client.patch).not.toHaveBeenCalled();
  });
});

const makeClient = ({ publishOk = true, runtimeToken = null } = {}) => {
  const post = jest.fn(async (route, body) => {
    if (route === '/api/registry/publish') {
      if (!publishOk) throw new Error('already published');
      return { ok: true };
    }
    if (route === '/api/registry/install') {
      return {
        installation: {
          agentName: body.agentName,
          instanceId: 'default',
          podId: body.podId,
        },
        ...(runtimeToken ? { runtimeToken } : {}),
      };
    }
    if (route.endsWith('/runtime-tokens')) {
      return { token: 'cm_agent_from_tokens_route' };
    }
    throw new Error(`unexpected POST to ${route}`);
  });
  return { post, get: jest.fn() };
};

describe('performAttach', () => {
  beforeEach(() => {
    fs.rmSync(path.join(tokensTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('detects the adapter, publishes, installs, and returns a runtime token', async () => {
    const client = makeClient({ runtimeToken: 'cm_agent_from_install' });
    const result = await performAttach({
      client,
      adapterName: 'stub',
      agentName: 'my-stub',
      podId: 'pod-1',
      displayName: 'My Stub',
    });

    expect(result.runtimeToken).toBe('cm_agent_from_install');
    expect(result.wrappedCli).toBe('stub');
    expect(result.installation.agentName).toBe('my-stub');
    expect(result.instanceId).toBe('default');
    expect(result.detected.path).toBe('(builtin)');

    // Post-refactor: runtimeType is per-adapter (e.g. 'stub', 'claude-code',
    // 'codex'); the legacy `wrappedCli` slot is folded into `runtimeType` and
    // 'host: byo' distinguishes a CLI-attached agent from a hosted one of the
    // same identity. The stub adapter declares runtimeType='stub'.
    expect(client.post).toHaveBeenCalledWith(
      '/api/registry/publish',
      expect.objectContaining({
        manifest: expect.objectContaining({
          name: 'my-stub',
          runtimeType: 'stub',
        }),
      }),
    );
    expect(client.post).toHaveBeenCalledWith(
      '/api/registry/install',
      expect.objectContaining({
        agentName: 'my-stub',
        podId: 'pod-1',
        config: expect.objectContaining({
          runtime: expect.objectContaining({
            runtimeType: 'stub',
            host: 'byo',
          }),
        }),
      }),
    );
  });

  test('omits config.wakeOnMessage by default (ADR-018 ambient wake is opt-in)', async () => {
    const client = makeClient({ runtimeToken: 'cm_agent_x' });
    await performAttach({
      client, adapterName: 'stub', agentName: 'quiet', podId: 'pod-1',
    });
    const installBody = client.post.mock.calls.find(([route]) => route === '/api/registry/install')[1];
    expect(installBody.config).not.toHaveProperty('wakeOnMessage');
  });

  test('--wake-on-message sets config.wakeOnMessage.enabled on install', async () => {
    const client = makeClient({ runtimeToken: 'cm_agent_x' });
    await performAttach({
      client, adapterName: 'stub', agentName: 'ambient', podId: 'pod-1', wakeOnMessage: true,
    });
    expect(client.post).toHaveBeenCalledWith(
      '/api/registry/install',
      expect.objectContaining({
        config: expect.objectContaining({ wakeOnMessage: { enabled: true } }),
      }),
    );
  });

  test('falls back to /runtime-tokens when install does not return runtimeToken', async () => {
    const client = makeClient({ runtimeToken: null });
    const result = await performAttach({
      client,
      adapterName: 'stub',
      agentName: 'my-stub',
      podId: 'pod-2',
    });

    expect(result.runtimeToken).toBe('cm_agent_from_tokens_route');
    // force:true is required so the server clears the User row's hashed
    // token (preserved across detach per ADR-001 identity-continuity) and
    // mints a fresh raw token. Without force:true, re-attach after detach
    // gets {existing:true} with no token. See registry.runtime-tokens.test.js
    // and the 2026-04-17 detach+reattach race fix.
    expect(client.post).toHaveBeenCalledWith(
      '/api/registry/pods/pod-2/agents/my-stub/runtime-tokens',
      { force: true },
    );
  });

  test('swallows publish errors (agent may already be published) and continues', async () => {
    const client = makeClient({ publishOk: false, runtimeToken: 'cm_agent_ok' });
    const result = await performAttach({
      client,
      adapterName: 'stub',
      agentName: 'my-stub',
      podId: 'pod-3',
    });

    expect(result.runtimeToken).toBe('cm_agent_ok');
    // publish was attempted and swallowed; install still happened
    expect(client.post).toHaveBeenCalledWith(
      '/api/registry/install',
      expect.any(Object),
    );
  });

  test('rejects unknown adapter names', async () => {
    const client = makeClient();
    await expect(performAttach({
      client,
      adapterName: 'does-not-exist',
      agentName: 'x',
      podId: 'p',
    })).rejects.toThrow(/Unknown adapter/);
    expect(client.post).not.toHaveBeenCalled();
  });

  // Note: an integration test that exercised the full performAttach flow
  // with adapterName='claude' was removed when wiring CLI tests into CI
  // (#450/PR #453). It depended on `claude --version` succeeding on PATH,
  // which CI runners do not have. The behavior is fully covered by the
  // adapter-agnostic stub-adapter test above + the buildDefaultEnvironment
  // unit tests in the second describe block.

  test('stub adapter (no MCP support) attaches without a default environment', async () => {
    const client = makeClient({ runtimeToken: 'cm_agent_stub' });
    await performAttach({
      client,
      adapterName: 'stub',
      agentName: 'my-stub-no-mcp',
      podId: 'pod-stub',
    });

    const installCall = client.post.mock.calls.find(([route]) => route === '/api/registry/install');
    expect(installCall).toBeDefined();
    // Default env is gated to adapters that read --mcp-config; stub omits it.
    expect(installCall[1].config.environment).toBeUndefined();
  });
});

describe('buildDefaultEnvironment', () => {
  test('returns null for adapters with no MCP consumption path (stub)', () => {
    expect(buildDefaultEnvironment('stub')).toBeNull();
    expect(buildDefaultEnvironment('does-not-exist')).toBeNull();
  });

  test.each(['claude', 'codex'])('returns a single mcp entry for %s with placeholder env values', (adapterName) => {
    // codex joined the set after the 2026-07-22 as-operator attribution
    // incident: an MCP-less codex agent has no sanctioned posting tool and
    // falls back to whatever it finds in the shell (the operator's CLI
    // profile — posting AS the human).
    const env = buildDefaultEnvironment(adapterName);
    expect(env.mcp).toHaveLength(1);
    expect(env.mcp[0].name).toBe('commonly');
    expect(env.mcp[0].transport).toBe('stdio');
    // Placeholders are substituted at spawn-time by the adapter; the env file
    // itself MUST stay free of secrets so it can be checked in.
    expect(env.mcp[0].env.COMMONLY_AGENT_TOKEN).toBe('${COMMONLY_AGENT_TOKEN}');
    expect(env.mcp[0].env.COMMONLY_API_URL).toBe('${COMMONLY_API_URL}');
  });
});

describe('saveAgentToken / loadAgentToken', () => {
  beforeEach(() => {
    fs.rmSync(path.join(tokensTmpDir, '.commonly'), { recursive: true, force: true });
  });

  test('persists and reads back the token record, stamping savedAt', () => {
    saveAgentToken('my-stub', {
      agentName: 'my-stub',
      instanceId: 'default',
      podId: 'pod-1',
      instanceUrl: 'http://localhost:5000',
      runtimeToken: 'cm_agent_xyz',
      adapter: 'stub',
    });

    const loaded = loadAgentToken('my-stub');
    expect(loaded.runtimeToken).toBe('cm_agent_xyz');
    expect(loaded.adapter).toBe('stub');
    expect(loaded.podId).toBe('pod-1');
    expect(loaded.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // On-disk file is at ~/.commonly/tokens/<name>.json
    const file = path.join(tokensTmpDir, '.commonly', 'tokens', 'my-stub.json');
    expect(fs.existsSync(file)).toBe(true);
  });

  test('loadAgentToken returns null when the file does not exist', () => {
    expect(loadAgentToken('never-attached')).toBeNull();
  });
});

// ── #913: bootstrap the token record from env vars on first `agent run` ─────
describe('bootstrapAgentRecordFromEnv', () => {
  const identityResponse = {
    agentName: 'smoke-agent',
    instanceId: 'default',
    installations: [
      { podId: 'pod-dm', podType: 'agent-admin', instanceId: 'default', status: 'active', type: 'dm' },
      { podId: 'pod-main', podType: 'chat', instanceId: 'default', status: 'active', type: 'installation' },
    ],
  };

  const makeRegistry = ({ claudeFound = true, codexFound = true } = {}) => ({
    getAdapter: (n) => ({
      claude: { name: 'claude', detect: async () => (claudeFound ? { path: '/bin/claude', version: '1' } : null) },
      codex: { name: 'codex', detect: async () => (codexFound ? { path: '/bin/codex', version: '1' } : null) },
    }[n] || null),
    listAdapterNames: () => ['stub', 'claude', 'codex'],
  });

  const makeFactory = (response = identityResponse) => {
    const get = jest.fn(async (route) => {
      if (route === '/api/agents/runtime/installations') return response;
      throw new Error(`unexpected GET ${route}`);
    });
    return jest.fn(() => ({ get }));
  };

  test('returns null when COMMONLY_AGENT_TOKEN is not set', async () => {
    const record = await bootstrapAgentRecordFromEnv({ name: 'smoke-agent', env: {} });
    expect(record).toBeNull();
  });

  test('rejects a non-runtime token instead of sending it anywhere', async () => {
    const factory = makeFactory();
    await expect(bootstrapAgentRecordFromEnv({
      name: 'smoke-agent',
      env: { COMMONLY_AGENT_TOKEN: 'eyJhbGciOi-user-jwt' },
      clientFactory: factory,
    })).rejects.toThrow(/cm_agent_/);
    expect(factory).not.toHaveBeenCalled();
  });

  test('synthesizes a full record from the installations endpoint + detected adapter', async () => {
    const factory = makeFactory();
    const record = await bootstrapAgentRecordFromEnv({
      name: 'smoke-agent',
      env: {
        COMMONLY_AGENT_TOKEN: 'cm_agent_abc123',
        COMMONLY_API_URL: 'https://api.example.test',
      },
      clientFactory: factory,
      adapterRegistry: makeRegistry(),
    });

    expect(factory).toHaveBeenCalledWith({ instance: 'https://api.example.test', token: 'cm_agent_abc123' });
    expect(record.agentName).toBe('smoke-agent');
    expect(record.instanceId).toBe('default');
    // podId prefers the real installation over the agent-admin DM row
    expect(record.podId).toBe('pod-main');
    expect(record.instanceUrl).toBe('https://api.example.test');
    expect(record.runtimeToken).toBe('cm_agent_abc123');
    expect(record.adapter).toBe('claude');
    expect(record.workspacePath).toBeNull();
    // environment matches what attach would have written for the same adapter
    expect(record.environment.mcp[0].name).toBe('commonly');
    expect(record.environment.mcp[0].env.COMMONLY_AGENT_TOKEN).toBe('${COMMONLY_AGENT_TOKEN}');
  });

  test('falls through the detect order when the first CLI is absent', async () => {
    const record = await bootstrapAgentRecordFromEnv({
      name: 'smoke-agent',
      env: { COMMONLY_AGENT_TOKEN: 'cm_agent_abc123', COMMONLY_API_URL: 'https://api.example.test' },
      clientFactory: makeFactory(),
      adapterRegistry: makeRegistry({ claudeFound: false }),
    });
    expect(record.adapter).toBe('codex');
  });

  test('errors with install guidance when no CLI is on PATH', async () => {
    await expect(bootstrapAgentRecordFromEnv({
      name: 'smoke-agent',
      env: { COMMONLY_AGENT_TOKEN: 'cm_agent_abc123', COMMONLY_API_URL: 'https://api.example.test' },
      clientFactory: makeFactory(),
      adapterRegistry: makeRegistry({ claudeFound: false, codexFound: false }),
    })).rejects.toThrow(/No supported agent CLI found on PATH/);
  });

  test('honors --adapter override and validates it', async () => {
    const record = await bootstrapAgentRecordFromEnv({
      name: 'smoke-agent',
      env: { COMMONLY_AGENT_TOKEN: 'cm_agent_abc123', COMMONLY_API_URL: 'https://api.example.test' },
      clientFactory: makeFactory(),
      adapterRegistry: makeRegistry(),
      adapterOverride: 'codex',
    });
    expect(record.adapter).toBe('codex');

    await expect(bootstrapAgentRecordFromEnv({
      name: 'smoke-agent',
      env: { COMMONLY_AGENT_TOKEN: 'cm_agent_abc123', COMMONLY_API_URL: 'https://api.example.test' },
      clientFactory: makeFactory(),
      adapterRegistry: makeRegistry(),
      adapterOverride: 'gemini',
    })).rejects.toThrow(/Unknown adapter 'gemini'/);
  });

  test("the token's identity wins over a mistyped CLI argument", async () => {
    const log = jest.fn();
    const record = await bootstrapAgentRecordFromEnv({
      name: 'smoke-agnet',
      env: { COMMONLY_AGENT_TOKEN: 'cm_agent_abc123', COMMONLY_API_URL: 'https://api.example.test' },
      clientFactory: makeFactory(),
      adapterRegistry: makeRegistry(),
      log,
    });
    expect(record.agentName).toBe('smoke-agent');
    expect(log).toHaveBeenCalledWith(expect.stringContaining("token belongs to 'smoke-agent'"));
  });

  test('wraps identity-resolution failures with the URL and a copy hint', async () => {
    const get = jest.fn(async () => { throw new Error('HTTP 401'); });
    await expect(bootstrapAgentRecordFromEnv({
      name: 'smoke-agent',
      env: { COMMONLY_AGENT_TOKEN: 'cm_agent_abc123', COMMONLY_API_URL: 'https://api.example.test' },
      clientFactory: () => ({ get }),
      adapterRegistry: makeRegistry(),
    })).rejects.toThrow(/against https:\/\/api\.example\.test: HTTP 401/);
  });
});
