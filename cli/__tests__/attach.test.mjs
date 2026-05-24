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
  saveAgentToken,
  loadAgentToken,
  buildDefaultEnvironment,
} = await import('../src/commands/agent.js');

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

  test('claude attach without --env installs with default commonly-mcp environment (#440)', async () => {
    const client = makeClient({ runtimeToken: 'cm_agent_ok' });
    await performAttach({
      client,
      adapterName: 'claude',
      agentName: 'my-claude',
      podId: 'pod-mcp',
    });

    expect(client.post).toHaveBeenCalledWith(
      '/api/registry/install',
      expect.objectContaining({
        config: expect.objectContaining({
          environment: expect.objectContaining({
            mcp: expect.arrayContaining([
              expect.objectContaining({
                name: 'commonly',
                command: ['npx', '-y', '@commonlyai/mcp@latest'],
                env: expect.objectContaining({
                  COMMONLY_API_URL: '${COMMONLY_API_URL}',
                  COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}',
                }),
              }),
            ]),
          }),
        }),
      }),
    );
  });

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
  test('returns null for adapters that do not consume --mcp-config (codex, stub)', () => {
    expect(buildDefaultEnvironment('codex')).toBeNull();
    expect(buildDefaultEnvironment('stub')).toBeNull();
    expect(buildDefaultEnvironment('does-not-exist')).toBeNull();
  });

  test('returns a single mcp entry for claude with placeholder env values', () => {
    const env = buildDefaultEnvironment('claude');
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
