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

    expect(client.post).toHaveBeenCalledWith(
      '/api/registry/publish',
      expect.objectContaining({
        manifest: expect.objectContaining({
          name: 'my-stub',
          runtimeType: 'local-cli',
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
            runtimeType: 'local-cli',
            wrappedCli: 'stub',
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
    expect(client.post).toHaveBeenCalledWith(
      '/api/registry/pods/pod-2/agents/my-stub/runtime-tokens',
      {},
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
