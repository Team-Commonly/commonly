// @ts-nocheck
// "Load older messages" worked on the anonymous showcase route but not in a
// pod you had actually joined — because it was never built there. The
// authenticated reader fired exactly one `?limit=50` request, tracked no
// cursor, and exposed no way to ask for anything older. The backend already
// accepted `before`, so the whole gap was client-side.
import { renderHook, act, waitFor } from '@testing-library/react';
import { useV2PodDetail } from '../hooks/useV2PodDetail';

const mockApi = { get: jest.fn(), post: jest.fn() };
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({
    socket: { on: jest.fn(), off: jest.fn() },
    connected: false,
    joinPod: jest.fn(),
    leavePod: jest.fn(),
  }),
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'me' } }),
}));

const PAGE = 50;
const makePage = (prefix, count, startMinute) => Array.from({ length: count }, (_, i) => ({
  id: `${prefix}${i}`,
  pod_id: 'p1',
  user_id: 'u1',
  content: `${prefix}-${i}`,
  message_type: 'text',
  created_at: new Date(Date.UTC(2026, 0, 1, 0, startMinute + i)).toISOString(),
}));

const routeMock = (messagesByCall) => {
  let call = 0;
  mockApi.get.mockImplementation((url) => {
    if (url.startsWith('/api/messages/')) {
      const res = messagesByCall[Math.min(call, messagesByCall.length - 1)];
      call += 1;
      return Promise.resolve(res);
    }
    if (url.includes('/agents')) return Promise.resolve({ agents: [] });
    return Promise.resolve({ _id: 'p1', name: 'Pod', members: [] });
  });
};

describe('useV2PodDetail pagination', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports hasMore when the first page comes back full', async () => {
    routeMock([makePage('a', PAGE, 100)]);
    const { result } = renderHook(() => useV2PodDetail('p1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(PAGE));
    expect(result.current.hasMore).toBe(true);
  });

  it('reports no more history when the first page is short', async () => {
    routeMock([makePage('a', 3, 100)]);
    const { result } = renderHook(() => useV2PodDetail('p1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(3));
    expect(result.current.hasMore).toBe(false);
  });

  it('loadOlder requests `before` the oldest held message and PREPENDS the page', async () => {
    const first = makePage('new', PAGE, 100);
    const older = makePage('old', 10, 0);
    routeMock([first, older]);

    const { result } = renderHook(() => useV2PodDetail('p1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(PAGE));

    await act(async () => { await result.current.loadOlder(); });

    const olderCall = mockApi.get.mock.calls
      .map((c) => c[0])
      .find((u) => typeof u === 'string' && u.includes('before='));
    expect(olderCall).toContain(`before=${encodeURIComponent(first[0].created_at)}`);

    // Prepended, chronological, nothing lost.
    expect(result.current.messages).toHaveLength(PAGE + 10);
    expect(result.current.messages[0].id).toBe('old0');
    expect(result.current.messages[result.current.messages.length - 1].id).toBe(`new${PAGE - 1}`);
    // A short older page means we have reached the beginning.
    expect(result.current.hasMore).toBe(false);
  });

  it('does not duplicate a message the socket delivered while the page was in flight', async () => {
    const first = makePage('a', PAGE, 100);
    // The older page overlaps the newest list by one id.
    const overlapping = [...makePage('old', 5, 0), first[0]];
    routeMock([first, overlapping]);

    const { result } = renderHook(() => useV2PodDetail('p1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(PAGE));

    await act(async () => { await result.current.loadOlder(); });

    const ids = result.current.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.current.messages).toHaveLength(PAGE + 5);
  });

  it('is a no-op with no messages, so the first render cannot fire a bogus cursor', async () => {
    routeMock([[]]);
    const { result } = renderHook(() => useV2PodDetail('p1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.loadOlder(); });

    expect(mockApi.get.mock.calls.filter((c) => String(c[0]).includes('before=')))
      .toHaveLength(0);
  });

  it('keeps hasMore true when a page request fails, so the button can be retried', async () => {
    const first = makePage('a', PAGE, 100);
    let call = 0;
    mockApi.get.mockImplementation((url) => {
      if (url.startsWith('/api/messages/')) {
        call += 1;
        if (call === 1) return Promise.resolve(first);
        return Promise.reject(new Error('network'));
      }
      if (url.includes('/agents')) return Promise.resolve({ agents: [] });
      return Promise.resolve({ _id: 'p1', name: 'Pod', members: [] });
    });

    const { result } = renderHook(() => useV2PodDetail('p1'));
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => { await result.current.loadOlder(); });

    expect(result.current.hasMore).toBe(true);
    expect(result.current.loadingOlder).toBe(false);
  });
});
