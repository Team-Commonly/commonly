// @ts-nocheck
// F576: the kernel rewrites a message in place (an agent's install intro, on
// its first listen) and tells the pod over `messageUpdated`. The open thread
// merges whichever of content and payload the event carries.
import { act, renderHook, waitFor } from '@testing-library/react';
import { useV2PodDetail } from '../hooks/useV2PodDetail';

const mockApi = { get: jest.fn(), post: jest.fn() };
let mockConnected = true;
const mockSocket = { on: jest.fn(), off: jest.fn() };
const mockJoinPod = jest.fn();
const mockLeavePod = jest.fn();

jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));
jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: mockSocket, connected: mockConnected, joinPod: mockJoinPod, leavePod: mockLeavePod }),
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'human-1' } }),
}));

const intro = {
  id: '41', pod_id: 'pod-1', user_id: 'agent-1', message_type: 'text',
  content: 'Hi all. As I post this, nothing is running me yet.',
  payload: { kind: 'install-intro' },
  created_at: '2026-11-24T12:00:00.000Z',
};
const other = { ...intro, id: '42', content: 'hello', payload: undefined, created_at: '2026-11-24T12:01:00.000Z' };

const handler = () => mockSocket.on.mock.calls.filter(([event]) => event === 'messageUpdated').at(-1)?.[1];
const byId = (result) => Object.fromEntries(result.current.messages.map((m) => [m.id, m]));

describe('useV2PodDetail messageUpdated (F576)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnected = true;
    mockApi.get.mockImplementation((url) => {
      if (url === '/api/messages/pod-1?limit=50') return Promise.resolve([intro, other]);
      if (url.includes('/agents')) return Promise.resolve({ agents: [] });
      return Promise.resolve({ _id: 'pod-1', name: 'Pod', members: [] });
    });
  });

  it('merges new content and payload into the matching message only', async () => {
    const { result } = renderHook(() => useV2PodDetail('pod-1'));
    await waitFor(() => expect(result.current.initialLoadComplete).toBe(true));
    expect(handler()).toBeDefined();

    act(() => {
      handler()({
        messageId: '41',
        podId: 'pod-1',
        content: 'Hi all. Mention me with @rivet when you need me.',
        payload: { kind: 'install-intro', introState: 'listening' },
      });
    });
    expect(byId(result)['41'].content).toBe('Hi all. Mention me with @rivet when you need me.');
    expect(byId(result)['41'].payload).toEqual({ kind: 'install-intro', introState: 'listening' });
    expect(byId(result)['42'].content).toBe('hello');
  });

  it('keeps fields the event leaves out, and ignores other pods and unknown ids', async () => {
    const { result } = renderHook(() => useV2PodDetail('pod-1'));
    await waitFor(() => expect(result.current.initialLoadComplete).toBe(true));
    act(() => { handler()({ messageId: '41', podId: 'pod-1', content: 'new text' }); });
    act(() => { handler()({ messageId: '41', podId: 'pod-2', content: 'wrong pod' }); });
    act(() => { handler()({ messageId: '99', podId: 'pod-1', content: 'nobody' }); });
    expect(byId(result)['41'].content).toBe('new text');
    expect(byId(result)['41'].payload).toEqual({ kind: 'install-intro' });
    expect(result.current.messages).toHaveLength(2);
  });

  // A later history page merges with messagesRef; a stale ref would put the
  // pre-rewrite intro back (CodeRabbit on #4264).
  it('a rewrite survives a later loadOlder', async () => {
    const older = { ...intro, id: '40', content: 'older', payload: undefined, created_at: '2026-11-24T11:00:00.000Z' };
    mockApi.get.mockImplementation((url) => {
      if (url === '/api/messages/pod-1?limit=50') return Promise.resolve([intro, other]);
      if (url.startsWith('/api/messages/pod-1?limit=50&before=')) return Promise.resolve([older]);
      if (url.includes('/agents')) return Promise.resolve({ agents: [] });
      return Promise.resolve({ _id: 'pod-1', name: 'Pod', members: [] });
    });
    const { result } = renderHook(() => useV2PodDetail('pod-1'));
    await waitFor(() => expect(result.current.initialLoadComplete).toBe(true));
    act(() => {
      handler()({
        messageId: '41', podId: 'pod-1', content: 'rewritten',
        payload: { kind: 'install-intro', introState: 'listening' },
      });
    });
    await act(async () => { await result.current.loadOlder(); });
    expect(result.current.messages.map((m) => m.id)).toEqual(['40', '41', '42']);
    expect(byId(result)['41'].content).toBe('rewritten');
    expect(byId(result)['41'].payload).toEqual({ kind: 'install-intro', introState: 'listening' });
  });

  describe('reconnect catch-up', () => {
    const reconnectWith = (response) => {
      let reads = 0;
      mockApi.get.mockImplementation((url) => {
        if (url === '/api/messages/pod-1?limit=50') {
          reads += 1;
          return reads === 1 ? Promise.resolve([intro, other]) : response;
        }
        if (url.includes('/agents')) return Promise.resolve({ agents: [] });
        return Promise.resolve({ _id: 'pod-1', name: 'Pod', members: [] });
      });
    };
    const bounce = async (result, rerender) => {
      await waitFor(() => expect(result.current.initialLoadComplete).toBe(true));
      act(() => { mockConnected = false; rerender(); });
      act(() => { mockConnected = true; rerender(); });
    };

    it('the server row wins for a message rewritten while the tab was disconnected', async () => {
      const rewritten = { ...intro, content: 'rewritten offline', payload: { kind: 'install-intro', introState: 'listening' } };
      reconnectWith(Promise.resolve([rewritten, other]));
      const { result, rerender } = renderHook(() => useV2PodDetail('pod-1'));
      await bounce(result, rerender);
      await waitFor(() => expect(byId(result)['41'].content).toBe('rewritten offline'));
      expect(byId(result)['41'].payload).toEqual({ kind: 'install-intro', introState: 'listening' });
      expect(result.current.messages).toHaveLength(2);
    });

    it('keeps a messageUpdated that arrived while the catch-up was in flight', async () => {
      let resolveReconnect;
      const pending = new Promise((resolve) => { resolveReconnect = resolve; });
      reconnectWith(pending);
      const { result, rerender } = renderHook(() => useV2PodDetail('pod-1'));
      await bounce(result, rerender);
      await waitFor(() => expect(mockApi.get.mock.calls.filter(([u]) => u === '/api/messages/pod-1?limit=50')).toHaveLength(2));
      act(() => { handler()({ messageId: '41', podId: 'pod-1', content: 'socket version' }); });
      await act(async () => {
        resolveReconnect([{ ...intro, content: 'stale server copy' }, { ...other, content: 'hello again' }]);
        await pending;
      });
      expect(byId(result)['41'].content).toBe('socket version');
      // Rows the socket did not touch still take the server's copy.
      expect(byId(result)['42'].content).toBe('hello again');
    });

    // Per field: a reaction in flight keeps only the reactions it changed.
    it('a reaction in flight keeps its reactions without dropping the fetched rewrite', async () => {
      let resolveReconnect;
      const pending = new Promise((resolve) => { resolveReconnect = resolve; });
      reconnectWith(pending);
      const { result, rerender } = renderHook(() => useV2PodDetail('pod-1'));
      await bounce(result, rerender);
      await waitFor(() => expect(mockApi.get.mock.calls.filter(([u]) => u === '/api/messages/pod-1?limit=50')).toHaveLength(2));
      const reaction = mockSocket.on.mock.calls.filter(([event]) => event === 'messageReaction').at(-1)[1];
      act(() => {
        reaction({
          messageId: '41', podId: 'pod-1',
          reactions: [{ emoji: '👍', count: 1, mine: false, users: [{ id: 'u2', username: 'other' }] }],
        });
      });
      await act(async () => {
        resolveReconnect([
          { ...intro, content: 'rewritten offline', payload: { kind: 'install-intro', introState: 'listening' } },
          other,
        ]);
        await pending;
      });
      expect(byId(result)['41'].content).toBe('rewritten offline');
      expect(byId(result)['41'].payload).toEqual({ kind: 'install-intro', introState: 'listening' });
      expect(byId(result)['41'].reactions).toEqual([
        expect.objectContaining({ emoji: '👍', count: 1 }),
      ]);
    });

    it('an older reconnect that answers after a newer one is ignored', async () => {
      let resolveFirst;
      let resolveSecond;
      const first = new Promise((resolve) => { resolveFirst = resolve; });
      const second = new Promise((resolve) => { resolveSecond = resolve; });
      let reads = 0;
      mockApi.get.mockImplementation((url) => {
        if (url === '/api/messages/pod-1?limit=50') {
          reads += 1;
          if (reads === 1) return Promise.resolve([intro, other]);
          return reads === 2 ? first : second;
        }
        if (url.includes('/agents')) return Promise.resolve({ agents: [] });
        return Promise.resolve({ _id: 'pod-1', name: 'Pod', members: [] });
      });
      const { result, rerender } = renderHook(() => useV2PodDetail('pod-1'));
      await bounce(result, rerender);
      await waitFor(() => expect(reads).toBe(2));
      act(() => { mockConnected = false; rerender(); });
      act(() => { mockConnected = true; rerender(); });
      await waitFor(() => expect(reads).toBe(3));
      act(() => { handler()({ messageId: '41', podId: 'pod-1', content: 'socket version' }); });
      await act(async () => {
        resolveSecond([{ ...intro, content: 'stale server copy' }, other]);
        await second;
      });
      await act(async () => {
        resolveFirst([{ ...intro, content: 'oldest copy' }, other]);
        await first;
      });
      expect(byId(result)['41'].content).toBe('socket version');
    });
  });
});
