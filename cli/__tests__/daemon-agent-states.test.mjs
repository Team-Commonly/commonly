import {
  createReachCache, loadReachByAgent, reachLabel, seatKey,
} from '../src/lib/daemon-agent-states.js';

// A user-token client stub: `routes` maps a path to its JSON body, or to an Error.
const fakeClient = (routes, calls = []) => ({
  get: async (path) => {
    calls.push(path);
    const body = routes[path];
    if (body instanceof Error) throw body;
    if (body === undefined) throw new Error(`no route ${path}`);
    return body;
  },
});

describe('reachLabel', () => {
  test('maps the server verdict to the words the watch prints', () => {
    expect(reachLabel('listening')).toBe('running');
    expect(reachLabel('reachable')).toBe('running');
    expect(reachLabel('gone-dark')).toBe('stalled');
    expect(reachLabel('never-connected')).toBe('not connected');
    expect(reachLabel('something-new')).toBe('unknown');
  });
});

describe('seatKey', () => {
  test('matches case-insensitively and treats a missing instance as default', () => {
    expect(seatKey('Dart', 'DART')).toBe(seatKey('dart', 'dart'));
    expect(seatKey('nova', undefined)).toBe('nova:default');
  });
});

describe('loadReachByAgent', () => {
  test('reads every member pod and keys each installation by agent and instance', async () => {
    const client = fakeClient({
      '/api/pods': [{ _id: 'p1' }, { _id: 'p2' }],
      '/api/pods/p1/agent-states': { agents: [{ agentName: 'dart', instanceId: 'dart', state: 'listening' }] },
      '/api/pods/p2/agent-states': { agents: [{ agentName: 'nova', instanceId: 'default', state: 'gone-dark' }] },
    });
    const map = await loadReachByAgent({ client });
    expect(map.get(seatKey('dart', 'dart'))).toBe('running');
    expect(map.get(seatKey('nova', 'default'))).toBe('stalled');
  });

  test('an agent installed in two pods takes its most alive verdict', async () => {
    const client = fakeClient({
      '/api/pods': { pods: [{ id: 'p1' }, { id: 'p2' }] },
      '/api/pods/p1/agent-states': { agents: [{ agentName: 'dart', instanceId: 'dart', state: 'gone-dark' }] },
      '/api/pods/p2/agent-states': { agents: [{ agentName: 'dart', instanceId: 'dart', state: 'listening' }] },
    });
    const map = await loadReachByAgent({ client });
    expect(map.get(seatKey('dart', 'dart'))).toBe('running');
  });

  test('a pod with no agents adds nothing; a failed pod read fails the whole load', async () => {
    const quiet = fakeClient({ '/api/pods': [{ _id: 'p1' }], '/api/pods/p1/agent-states': { agents: [] } });
    expect((await loadReachByAgent({ client: quiet })).size).toBe(0);
    const broken = fakeClient({ '/api/pods': [{ _id: 'p1' }], '/api/pods/p1/agent-states': new Error('503') });
    await expect(loadReachByAgent({ client: broken })).rejects.toThrow('503');
  });
});

describe('createReachCache', () => {
  test('reuses the verdict inside the ttl and reloads after it', async () => {
    let clock = 0;
    let loads = 0;
    const cache = createReachCache({ load: async () => { loads += 1; return new Map([['a', loads]]); }, ttlMs: 10_000, now: () => clock });
    expect((await cache()).get('a')).toBe(1);
    clock = 9_000;
    expect((await cache()).get('a')).toBe(1);
    clock = 10_000;
    expect((await cache()).get('a')).toBe(2);
  });

  test('a failed load is not cached, so the next call retries', async () => {
    let fail = true;
    const cache = createReachCache({ load: async () => { if (fail) throw new Error('down'); return new Map(); }, now: () => 0 });
    await expect(cache()).rejects.toThrow('down');
    fail = false;
    await expect(cache()).resolves.toBeInstanceOf(Map);
  });
});
