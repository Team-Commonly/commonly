/**
 * agent-list.test.mjs — D214 gap (TASK-667)
 *
 * Covers `runAgentList`:
 *   - `--pod` reads the member-gated pod roster, not the admin installs route
 *   - a non-member's 403 on `--pod` returns exit 1 with one Failed line
 *   - a non-admin's 403 with no `--pod` returns exit 1 and names the --pod fix
 *   - a missing login returns exit 1
 */

import { jest } from '@jest/globals';

const { runAgentList } = await import('../src/commands/agent.js');

const httpError = (status, message) => Object.assign(new Error(message), { status });

const fakeDeps = (getImpl) => {
  const get = jest.fn(getImpl);
  const log = jest.fn();
  const error = jest.fn();
  return {
    get,
    log,
    error,
    deps: {
      tokenFor: () => 'tok',
      instanceUrlFor: () => 'https://api.example.test',
      clientFactory: () => ({ get }),
      log,
      error,
    },
  };
};

describe('runAgentList', () => {
  test('--pod lists the seats of a pod member through the member-gated roster', async () => {
    const { get, log, deps } = fakeDeps(async () => ({
      agents: [
        {
          name: 'ember',
          instanceId: 'default',
          status: 'active',
          runtime: { runtimeType: 'wrapper', host: 'byo' },
          connection: { state: 'available', lastSeenAt: '2026-10-31T10:00:00.000Z' },
        },
      ],
    }));

    const code = await runAgentList({ pod: 'pod-42' }, deps);

    expect(code).toBe(0);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/api/registry/pods/pod-42/agents');
    const printed = log.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toMatch(/ember\s+default\s+wrapper/);
    expect(printed).not.toMatch(/undefined/);
  });

  // F44 (A): NAME and INSTANCE are two of an agent's three names; the third is
  // the one a person types. The roster carries it, and --pod prints it whole.
  test('--pod prints each agent\'s @mention handle in full', async () => {
    const { log, deps } = fakeDeps(async () => ({
      agents: [
        { name: 'cto-walk-1016', instanceId: 'cto-walk', mention: 'cto-walk-1016-cto-walk', status: 'active', runtimeType: 'native' },
        { name: 'ember', instanceId: 'default', status: 'active', runtimeType: 'wrapper' },
      ],
    }));

    expect(await runAgentList({ pod: 'pod-42' }, deps)).toBe(0);

    const [header, , first, second] = log.mock.calls.map((c) => c[0]);
    expect(header).toMatch(/^NAME\s+INSTANCE\s+HANDLE\s+RUNTIME/);
    expect(first).toMatch(/^cto-walk-1016\s+cto-walk\s+@cto-walk-1016-cto-walk\s+native/);
    // A roster from an older server has no handle: the column is blank, not "@undefined".
    expect(second).toMatch(/^ember\s+default\s+wrapper/);
    expect(second).not.toMatch(/@|undefined/);
  });

  test('without --pod the columns are unchanged: no HANDLE', async () => {
    const { log, deps } = fakeDeps(async () => ({
      installations: [{ agentName: 'cto-walk-1016', instanceId: 'cto-walk', mention: 'x', status: 'active', runtimeType: 'native' }],
    }));

    expect(await runAgentList({}, deps)).toBe(0);
    const [header, , row] = log.mock.calls.map((c) => c[0]);
    expect(header).toMatch(/^NAME\s+INSTANCE\s+RUNTIME/);
    expect(row).toMatch(/^cto-walk-1016\s+cto-walk\s+native/);
  });

  test('a non-member 403 on --pod exits 1 with one Failed line', async () => {
    const { log, error, deps } = fakeDeps(async () => {
      throw httpError(403, 'Access denied');
    });

    const code = await runAgentList({ pod: 'pod-other' }, deps);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('Failed: Access denied');
    expect(log).not.toHaveBeenCalled();
  });

  test('a non-admin 403 with no --pod exits 1 and names the --pod fix', async () => {
    const { get, error, deps } = fakeDeps(async () => {
      throw httpError(403, 'Admin access required');
    });

    const code = await runAgentList({}, deps);

    expect(code).toBe(1);
    expect(get).toHaveBeenCalledWith('/api/registry/admin/installations');
    expect(error).toHaveBeenCalledWith('Failed: Admin access required');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--pod <podId>'));
  });

  test('no login exits 1 without calling the API', async () => {
    const { get, error, deps } = fakeDeps(async () => ({ agents: [] }));

    const code = await runAgentList({ pod: 'pod-42' }, { ...deps, tokenFor: () => null });

    expect(code).toBe(1);
    expect(get).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Not logged in. Run: commonly login');
  });

  test('a 500 on the roster route exits 1 with one Failed line', async () => {
    const { log, error, deps } = fakeDeps(async () => {
      throw httpError(500, 'Failed to list pod agents');
    });

    const code = await runAgentList({ pod: 'pod-42' }, deps);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('Failed: Failed to list pod agents');
    expect(log).not.toHaveBeenCalled();
  });

  test('admin mode prints admin rows and falls back to lastActiveAt for LAST SEEN', async () => {
    const { log, deps } = fakeDeps(async () => ({
      installations: [
        {
          agentName: 'nova',
          instanceId: 'default',
          status: 'active',
          config: { runtime: { runtimeType: 'native', host: '' } },
          lastActiveAt: '2026-10-31T11:00:00.000Z',
        },
      ],
    }));

    const code = await runAgentList({}, deps);

    expect(code).toBe(0);
    const printed = log.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toMatch(/nova\s+default\s+native/);
    expect(printed).not.toMatch(/never/);
  });
});
