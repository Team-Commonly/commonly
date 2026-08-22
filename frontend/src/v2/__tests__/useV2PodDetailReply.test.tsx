// @ts-nocheck
// Regression for #646: the Socket.io newMessage copy of a just-sent reply
// can arrive before the POST response and used to win the dedupe wholesale.
// Older-backend broadcasts omit replyTo, so the reply rendered without its
// quoted context until reload. The dedupe must graft the POST copy's
// replyTo onto an already-present socket copy.
import { renderHook, act, waitFor } from '@testing-library/react';
import { useV2PodDetail } from '../hooks/useV2PodDetail';

const mockApi = {
  get: jest.fn(),
  post: jest.fn(),
};
jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => mockApi,
}));

const socketHandlers = {};
const mockSocket = {
  on: jest.fn((event, handler) => { socketHandlers[event] = handler; }),
  off: jest.fn((event) => { delete socketHandlers[event]; }),
};
jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({
    socket: mockSocket,
    connected: true,
    joinPod: jest.fn(),
    leavePod: jest.fn(),
  }),
}));
// useV2PodDetail now reads currentUser (to recompute reaction `mine` per-client);
// useAuth throws without an AuthProvider, so stub it here.
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'me' } }),
}));

describe('useV2PodDetail reply threading (#646)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.get.mockImplementation((url) => {
      if (url.startsWith('/api/messages/')) return Promise.resolve([]);
      if (url.includes('/agents')) return Promise.resolve({ agents: [] });
      return Promise.resolve({ _id: 'p1', name: 'Pod', members: [] });
    });
  });

  it('grafts the POST copy replyTo onto a socket copy that won the dedupe race', async () => {
    const replyTo = { id: 'm1', content: 'original', username: 'bob' };
    let resolvePost;
    mockApi.post.mockReturnValue(new Promise((resolve) => { resolvePost = resolve; }));

    const { result } = renderHook(() => useV2PodDetail('p1'));
    await waitFor(() => expect(socketHandlers.newMessage).toBeDefined());

    let sendPromise;
    act(() => {
      sendPromise = result.current.sendMessage('a reply', 'text', 'm1');
    });

    // Socket broadcast (older-backend shape: no replyTo) lands first.
    act(() => {
      socketHandlers.newMessage({
        id: 'm9', pod_id: 'p1', content: 'a reply', created_at: '2026-07-07T00:00:00Z',
      });
    });
    // POST response (carries replyTo) resolves second.
    await act(async () => {
      resolvePost({
        id: 'm9', pod_id: 'p1', content: 'a reply', created_at: '2026-07-07T00:00:00Z', replyTo,
      });
      await sendPromise;
    });

    const sent = result.current.messages.filter((m) => m.id === 'm9');
    expect(sent).toHaveLength(1);
    expect(sent[0].replyTo).toEqual(replyTo);
  });

  it('keeps a single copy when the POST response wins the race', async () => {
    const replyTo = { id: 'm1', content: 'original', username: 'bob' };
    mockApi.post.mockResolvedValue({
      id: 'm9', pod_id: 'p1', content: 'a reply', created_at: '2026-07-07T00:00:00Z', replyTo,
    });

    const { result } = renderHook(() => useV2PodDetail('p1'));
    await waitFor(() => expect(socketHandlers.newMessage).toBeDefined());

    await act(async () => {
      await result.current.sendMessage('a reply', 'text', 'm1');
    });
    act(() => {
      socketHandlers.newMessage({
        id: 'm9', pod_id: 'p1', content: 'a reply', created_at: '2026-07-07T00:00:00Z',
      });
    });

    const sent = result.current.messages.filter((m) => m.id === 'm9');
    expect(sent).toHaveLength(1);
    expect(sent[0].replyTo).toEqual(replyTo);
  });

  it('keeps a send failure separate from pod load errors', async () => {
    mockApi.post.mockRejectedValue({
      response: { data: { error: 'Replies are temporarily unavailable. Please try again shortly.' } },
    });

    const { result } = renderHook(() => useV2PodDetail('p1'));
    await waitFor(() => expect(socketHandlers.newMessage).toBeDefined());

    await act(async () => {
      await result.current.sendMessage('a reply', 'text', 'm1');
    });

    expect(result.current.sendError).toBe('Replies are temporarily unavailable. Please try again shortly.');
    expect(result.current.error).toBeNull();
  });
});
