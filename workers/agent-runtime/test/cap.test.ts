import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listEvents, ackEvent, postMessage, getPodContext, StaleDeliveryError } from '../src/cap';

const cfg = { apiUrl: 'https://api.test', runtimeToken: 'cm_agent_x' };

describe('CAP client — the four verbs a BYO wrapper speaks', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });

  it('lists pending events with the bearer + a non-default UA (Cloudflare 1010 lesson)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ events: [{ _id: 'e1', type: 'chat.mention' }] }) });
    const events = await listEvents(cfg);
    expect(events).toEqual([{ _id: 'e1', type: 'chat.mention' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/api/agents/runtime/events?status=pending');
    expect(init.headers.Authorization).toBe('Bearer cm_agent_x');
    expect(init.headers['User-Agent']).toMatch(/commonly-hosted-runtime/);
  });

  it('accepts a bare-array events response too', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [{ _id: 'e2', type: 'first_contact' }] });
    expect(await listEvents(cfg)).toHaveLength(1);
  });

  it('throws on non-2xx so the DO records lastError instead of acking blindly', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(listEvents(cfg)).rejects.toThrow('listEvents 401');
    await expect(ackEvent(cfg, 'e1')).rejects.toThrow('ackEvent 401');
    await expect(postMessage(cfg, 'p1', 'hi')).rejects.toThrow('postMessage 401');
    await expect(getPodContext(cfg, 'p1')).rejects.toThrow('getPodContext 401');
  });

  it('ack presents the delivery nonce when the claim carried one (ADR-026 D6)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await ackEvent(cfg, 'e1', 'nonce-abc');
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ deliveryId: 'nonce-abc' });
  });

  it('ack 409 with code stale_delivery is a StaleDeliveryError — stop, never retry', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ code: 'stale_delivery' }) });
    await expect(ackEvent(cfg, 'e1', 'old')).rejects.toBeInstanceOf(StaleDeliveryError);
  });

  it('a 409 WITHOUT the stale_delivery code stays a generic retryable error (Otto)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ code: 'something_else' }) });
    await expect(ackEvent(cfg, 'e1', 'old')).rejects.toThrow('ackEvent 409');
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => { throw new Error('no body'); } });
    await expect(ackEvent(cfg, 'e1', 'old')).rejects.toThrow('ackEvent 409');
  });

  it('posts a message as JSON to the pod route', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await postMessage(cfg, 'pod-1', 'hello');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/api/agents/runtime/pods/pod-1/messages');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ content: 'hello' });
  });
});
