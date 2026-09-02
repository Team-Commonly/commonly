// @ts-nocheck
// A room switch must be a clean boundary: a previous room's response may land
// late, but it must never paint under the new room header.
import { act, renderHook, waitFor } from '@testing-library/react';
import { useV2PodDetail } from '../hooks/useV2PodDetail';

const mockApi = { get: jest.fn(), post: jest.fn() };
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));
jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false, joinPod: jest.fn(), leavePod: jest.fn() }),
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'human-1' } }),
}));

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

describe('useV2PodDetail room changes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('clears immediately and rejects a late response from the previous room', async () => {
    const oldMessages = deferred();
    const newMessages = deferred();
    mockApi.get.mockImplementation((url) => {
      if (url === '/api/messages/old-room?limit=50') return oldMessages.promise;
      if (url === '/api/messages/new-room?limit=50') return newMessages.promise;
      if (url.includes('/agents')) return Promise.resolve({ agents: [] });
      const id = url.includes('new-room') ? 'new-room' : 'old-room';
      return Promise.resolve({ _id: id, name: id, members: [] });
    });

    const { result, rerender } = renderHook(({ podId }) => useV2PodDetail(podId), {
      initialProps: { podId: 'old-room' },
    });

    act(() => rerender({ podId: 'new-room' }));
    expect(result.current.messages).toEqual([]);

    await act(async () => {
      oldMessages.resolve([{
        id: 'old-message', pod_id: 'old-room', content: 'must not leak', created_at: '2026-09-02T00:00:00Z',
      }]);
      await Promise.resolve();
    });
    expect(result.current.messages).toEqual([]);

    await act(async () => {
      newMessages.resolve([{
        id: 'new-message', pod_id: 'new-room', content: 'new room only', created_at: '2026-09-02T00:00:01Z',
      }]);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.messages.map((message) => message.id)).toEqual(['new-message']));
  });
});
