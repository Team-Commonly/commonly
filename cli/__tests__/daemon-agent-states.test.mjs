import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createReachCache, loadPodReach, readSessionLastTurn, reachLabel, seatKey,
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

describe('loadPodReach', () => {
  test('reads one pod and keys each installation by agent and instance', async () => {
    const calls = [];
    const client = fakeClient({
      '/api/pods/p1/agent-states': {
        agents: [
          { agentName: 'dart', instanceId: 'dart', state: 'listening' },
          { agentName: 'nova', instanceId: 'default', state: 'gone-dark' },
        ],
      },
    }, calls);
    const map = await loadPodReach({ client, podId: 'p1' });
    expect(calls).toEqual(['/api/pods/p1/agent-states']);
    expect(map.get(seatKey('dart', 'dart'))).toBe('running');
    expect(map.get(seatKey('nova', 'default'))).toBe('stalled');
  });

  test('a pod read that fails throws, so the caller can say why', async () => {
    const client = fakeClient({ '/api/pods/p1/agent-states': new Error('503') });
    await expect(loadPodReach({ client, podId: 'p1' })).rejects.toThrow('503');
  });
});

describe('createReachCache', () => {
  test('merges pods, and an agent in two pods takes its most alive verdict', async () => {
    const pods = {
      p1: new Map([[seatKey('dart', 'dart'), 'stalled']]),
      p2: new Map([[seatKey('dart', 'dart'), 'running'], [seatKey('nova', 'default'), 'not connected']]),
    };
    const reachFor = createReachCache({ load: async (podId) => pods[podId] });
    const merged = await reachFor(['p1', 'p2']);
    expect(merged.get(seatKey('dart', 'dart'))).toBe('running');
    expect(merged.get(seatKey('nova', 'default'))).toBe('not connected');
  });

  test('reuses a pod inside the ttl and reloads it after', async () => {
    let clock = 0;
    let loads = 0;
    const reachFor = createReachCache({
      load: async () => { loads += 1; return new Map([['a:default', loads === 1 ? 'running' : 'stalled']]); },
      ttlMs: 10_000,
      now: () => clock,
    });
    expect((await reachFor(['p1'])).get('a:default')).toBe('running');
    clock = 9_000;
    expect((await reachFor(['p1'])).get('a:default')).toBe('running');
    expect(loads).toBe(1);
    clock = 10_000;
    expect((await reachFor(['p1'])).get('a:default')).toBe('stalled');
    expect(loads).toBe(2);
  });

  test('a failed pod read is not cached, so the next call retries it', async () => {
    let fail = true;
    const reachFor = createReachCache({
      load: async () => { if (fail) throw new Error('down'); return new Map(); },
      now: () => 0,
    });
    await expect(reachFor(['p1'])).rejects.toThrow('down');
    fail = false;
    await expect(reachFor(['p1'])).resolves.toBeInstanceOf(Map);
  });
});

describe('createReachCache under the rate limit', () => {
  test('keeps the last verdict for a pod whose refresh fails, and waits a ttl before retrying', async () => {
    let clock = 0;
    let fail = false;
    let loads = 0;
    const reachFor = createReachCache({
      load: async () => {
        loads += 1;
        if (fail) throw new Error('429');
        return new Map([['a:default', 'running']]);
      },
      ttlMs: 10_000,
      now: () => clock,
    });
    expect((await reachFor(['p1'])).get('a:default')).toBe('running');
    fail = true;
    clock = 10_000;
    expect((await reachFor(['p1'])).get('a:default')).toBe('running');
    expect(loads).toBe(2);
    clock = 15_000;
    expect((await reachFor(['p1'])).get('a:default')).toBe('running');
    expect(loads).toBe(2);
  });

  test('stretches the refresh so 11 pods stay under 60 reads a minute', async () => {
    let clock = 0;
    let loads = 0;
    const pods = Array.from({ length: 11 }, (_, i) => `p${i}`);
    const reachFor = createReachCache({
      load: async () => { loads += 1; return new Map(); },
      ttlMs: 10_000,
      now: () => clock,
    });
    await reachFor(pods);
    clock = 13_100;
    await reachFor(pods);
    expect(loads).toBe(11);
    clock = 13_200;
    await reachFor(pods);
    expect(loads).toBe(22);
  });
});

describe('readSessionLastTurn', () => {
  test('returns the most recent turn across pods, or null when there is no store', () => {
    const home = mkdtempSync(join(tmpdir(), 'dart-sessions-'));
    mkdirSync(join(home, '.commonly', 'sessions'), { recursive: true });
    writeFileSync(join(home, '.commonly', 'sessions', 'dart.json'), JSON.stringify({
      p1: { lastTurn: '2026-10-31T22:00:00Z' },
      p2: { lastTurn: '2026-10-31T22:58:00Z' },
    }));
    expect(readSessionLastTurn('dart', { home })).toBe('2026-10-31T22:58:00Z');
    expect(readSessionLastTurn('nova', { home })).toBeNull();
  });
});
