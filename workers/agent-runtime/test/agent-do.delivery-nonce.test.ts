import { beforeEach, describe, expect, it, vi } from 'vitest';

const cap = vi.hoisted(() => ({
  listEvents: vi.fn(),
  ackEvent: vi.fn(),
  postMessage: vi.fn(),
}));

vi.mock('../src/cap', () => ({
  ...cap,
  StaleDeliveryError: class StaleDeliveryError extends Error {},
}));

import { AgentRuntimeDO } from '../src/agent-do';

const cfg = { apiUrl: 'https://api.test', runtimeToken: 'cm_agent_x' };

const stateWith = (values: Record<string, unknown>) => {
  const data = new Map(Object.entries(values));
  const storage = {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === 'string') data.set(key, value);
      else Object.entries(key).forEach(([entry, stored]) => data.set(entry, stored));
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    setAlarm: vi.fn(async () => undefined),
  };
  return { storage, state: { storage } as unknown as DurableObjectState };
};

describe('AgentRuntimeDO D6 acknowledgement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('echoes the nonce from the actual polled-event payload', async () => {
    const { state } = stateWith({ runtimeToken: cfg.runtimeToken, pollSeconds: 5 });
    cap.listEvents.mockResolvedValue([
      {
        _id: 'event-1',
        type: 'unknown',
        payload: { deliveryId: 'delivery-from-claim' },
      },
    ]);
    cap.ackEvent.mockResolvedValue(undefined);
    const runtime = new AgentRuntimeDO(state, { COMMONLY_API_URL: cfg.apiUrl } as never);

    await runtime.alarm();

    expect(cap.ackEvent).toHaveBeenCalledWith(cfg, 'event-1', 'delivery-from-claim');
  });
});
