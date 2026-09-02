// The ordering in handleEvent IS #1344's fix: commitStagedReply must run
// AFTER a successful post and must NOT run when the post throws — that is
// what leaves the stage intact so a redelivery replays it instead of paying
// for the model again. sprint-review proved (#1366) that moving the commit
// above the post re-introduces #1344 with the whole suite green: staging.ts
// is well covered, but nothing exercised the CALL SITE where the order lives.
//
// This drives the DO through alarm() twice — post throws, then succeeds —
// and asserts the model ran ONCE across both deliveries. A refactor tidying
// this to "clear the stage, then post" reads as equivalent and goes red here.
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
import { stagedKey } from '../src/staging';

const cfg = { apiUrl: 'https://api.test', runtimeToken: 'cm_agent_x' };
const EVENT = {
  _id: 'event-1',
  type: 'chat.mention',
  podId: 'pod-1',
  payload: { content: 'ping' },
};

const stateWith = (values: Record<string, unknown>) => {
  const data = new Map(Object.entries(values));
  const storage = {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === 'string') data.set(key, value);
      else Object.entries(key).forEach(([entry, stored]) => data.set(entry, stored));
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    // pruneStaged lists on every stage; the existing harness predates it.
    list: vi.fn(async ({ prefix }: { prefix: string }) => {
      const out = new Map<string, unknown>();
      for (const [key, value] of data) if (key.startsWith(prefix)) out.set(key, value);
      return out;
    }),
    setAlarm: vi.fn(async () => undefined),
  };
  return { data, storage, state: { storage } as unknown as DurableObjectState };
};

describe('handleEvent reply-staging ordering (#1344 / #1366)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cap.listEvents.mockResolvedValue([EVENT]);
    cap.ackEvent.mockResolvedValue(undefined);
    turn.runTurn.mockResolvedValue('the reply');
  });

  it('a failed post leaves the stage intact and the event unprocessed', async () => {
    const { data, state } = stateWith({ runtimeToken: cfg.runtimeToken, pollSeconds: 5 });
    cap.postMessage.mockRejectedValue(new Error('502 from CAP'));

    await new AgentRuntimeDO(state, { COMMONLY_API_URL: cfg.apiUrl } as never).alarm();

    expect(data.get(stagedKey(EVENT._id))).toMatchObject({ reply: 'the reply' });
    expect(data.get('processedEventIds')).toBeUndefined();
    expect(cap.ackEvent).not.toHaveBeenCalled();
  });

  it('the redelivery replays the staged reply without re-running the model', async () => {
    const { data, state } = stateWith({ runtimeToken: cfg.runtimeToken, pollSeconds: 5 });
    const runtime = new AgentRuntimeDO(state, { COMMONLY_API_URL: cfg.apiUrl } as never);

    cap.postMessage.mockRejectedValueOnce(new Error('502 from CAP'));
    await runtime.alarm();
    cap.postMessage.mockResolvedValue(undefined);
    await runtime.alarm();

    // The whole point of #1344: one paid turn across two deliveries.
    expect(turn.runTurn).toHaveBeenCalledTimes(1);
    expect(cap.postMessage).toHaveBeenLastCalledWith(cfg, 'pod-1', 'the reply');
    // And the stage is cleared only once the post actually succeeded.
    expect(data.get(stagedKey(EVENT._id))).toBeUndefined();
  });

  it('a NO_REPLY turn posts nothing and still clears its stage', async () => {
    const { data, state } = stateWith({ runtimeToken: cfg.runtimeToken, pollSeconds: 5 });
    turn.runTurn.mockResolvedValue('NO_REPLY');

    await new AgentRuntimeDO(state, { COMMONLY_API_URL: cfg.apiUrl } as never).alarm();

    expect(cap.postMessage).not.toHaveBeenCalled();
    expect(data.get(stagedKey(EVENT._id))).toBeUndefined();
  });
});
