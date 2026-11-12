// F291 (CodeRabbit on #3624): /deprovision runs storage.deleteAll(), but a
// turn still running resumed afterwards and wrote its transcript and the
// poll's stamps back, and a later /provision picked that transcript up.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cap = vi.hoisted(() => ({
  listEvents: vi.fn(),
  ackEvent: vi.fn(),
  postMessage: vi.fn(),
}));
const turn = vi.hoisted(() => ({ runTurn: vi.fn() }));

vi.mock('../src/cap', () => ({
  ...cap,
  StaleDeliveryError: class StaleDeliveryError extends Error {},
}));
vi.mock('../src/turn', () => turn);

import { AgentRuntimeDO } from '../src/agent-do';

const fakeState = () => {
  const data = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === 'string') data.set(key, value);
      else Object.entries(key).forEach(([entry, stored]) => data.set(entry, stored));
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    deleteAll: vi.fn(async () => data.clear()),
    list: vi.fn(async ({ prefix }: { prefix: string }) => new Map(
      [...data.entries()].filter(([key]) => key.startsWith(prefix)),
    )),
    setAlarm: vi.fn(async () => undefined),
    deleteAlarm: vi.fn(async () => undefined),
  };
  return { data, state: { storage } as unknown as DurableObjectState };
};

const request = (path: string, body?: unknown) => new Request(`https://do.test${path}`, {
  method: 'POST',
  ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
});

const provision = (runtime: AgentRuntimeDO, token = 'cm_agent_x') => runtime.fetch(
  request('/provision', { agentName: 'helper', instanceId: 'default', runtimeToken: token }),
);

const mention = { _id: 'event-1', type: 'chat.mention', podId: 'pod-1', payload: { content: 'hi', deliveryId: 'd-1' } };

describe('a turn that finishes after the object was deprovisioned', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cap.listEvents.mockResolvedValue([mention]);
    cap.ackEvent.mockResolvedValue(undefined);
    cap.postMessage.mockResolvedValue(undefined);
  });

  it('writes nothing back: no transcript, staged reply, processed id or poll stamp', async () => {
    const { data, state } = fakeState();
    const runtime = new AgentRuntimeDO(state, { COMMONLY_API_URL: 'https://api.test' } as never);
    await provision(runtime);
    turn.runTurn.mockImplementation(async (deps: { storage: { put: (k: string, v: unknown) => Promise<void> } }) => {
      await runtime.fetch(request('/deprovision'));
      await deps.storage.put('transcript', [{ role: 'user' }]);
      return 'An answer.';
    });

    await runtime.alarm();

    expect([...data.keys()]).toEqual([]);
  });

  it('writes nothing into a provisioning that started after it', async () => {
    const { data, state } = fakeState();
    const runtime = new AgentRuntimeDO(state, { COMMONLY_API_URL: 'https://api.test' } as never);
    await provision(runtime);
    turn.runTurn.mockImplementation(async (deps: { storage: { put: (k: string, v: unknown) => Promise<void> } }) => {
      await runtime.fetch(request('/deprovision'));
      await provision(runtime, 'cm_agent_y');
      await deps.storage.put('transcript', [{ role: 'user' }]);
      return 'An answer.';
    });

    await runtime.alarm();

    expect(data.get('transcript')).toBeUndefined();
    expect(data.get('processedEventIds')).toBeUndefined();
    expect(data.get('lastPollAt')).toBeUndefined();
    expect(data.get('runtimeToken')).toBe('cm_agent_y');
    // One alarm per provisioning: the old poll's chain does not re-arm.
    expect(state.storage.setAlarm).toHaveBeenCalledTimes(2);
  });

  it('an object provisioned before generations existed is blocked once it is provisioned again', async () => {
    const { data, state } = fakeState();
    data.set('agentName', 'helper');
    data.set('runtimeToken', 'cm_agent_x');
    const runtime = new AgentRuntimeDO(state, { COMMONLY_API_URL: 'https://api.test' } as never);
    turn.runTurn.mockImplementation(async (deps: { storage: { put: (k: string, v: unknown) => Promise<void> } }) => {
      await deps.storage.put('before', true);
      await provision(runtime, 'cm_agent_y');
      await deps.storage.put('transcript', [{ role: 'user' }]);
      return 'An answer.';
    });

    await runtime.alarm();

    expect(data.get('before')).toBe(true);
    expect(data.get('transcript')).toBeUndefined();
  });

  it('a turn that finishes while still provisioned writes as before', async () => {
    const { data, state } = fakeState();
    const runtime = new AgentRuntimeDO(state, { COMMONLY_API_URL: 'https://api.test' } as never);
    await provision(runtime);
    turn.runTurn.mockImplementation(async (deps: { storage: { put: (k: string, v: unknown) => Promise<void> } }) => {
      await deps.storage.put('transcript', [{ role: 'user' }]);
      return 'An answer.';
    });

    await runtime.alarm();

    expect(data.get('transcript')).toEqual([{ role: 'user' }]);
    expect(data.get('processedEventIds')).toEqual(['event-1']);
    expect(typeof data.get('lastPollAt')).toBe('number');
    expect(cap.postMessage).toHaveBeenCalledWith(expect.anything(), 'pod-1', 'An answer.');
  });
});
