// @ts-nocheck
import { act, renderHook, waitFor } from '@testing-library/react';
import { useV2PodDetail } from '../hooks/useV2PodDetail';

const mockApi = { get: jest.fn(), post: jest.fn() };
let mockConnected = true;
const mockSocket = { on: jest.fn(), off: jest.fn() };
const mockJoinPod = jest.fn();
const mockLeavePod = jest.fn();

jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));
jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({
    socket: mockSocket,
    connected: mockConnected,
    joinPod: mockJoinPod,
    leavePod: mockLeavePod,
  }),
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'human-1' } }),
}));

const message = (id, minute) => ({
  id,
  pod_id: 'pod-1',
  user_id: 'agent-1',
  content: id,
  message_type: 'text',
  created_at: new Date(Date.UTC(2026, 9, 19, 12, minute)).toISOString(),
});

const messageGets = () => mockApi.get.mock.calls
  .filter(([url]) => url === '/api/messages/pod-1?limit=50');

describe('useV2PodDetail reconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnected = true;
    mockApi.get.mockImplementation((url) => {
      if (url === '/api/messages/pod-1?limit=50') return Promise.resolve([message('before-outage', 0)]);
      if (url.includes('/agents')) return Promise.resolve({ agents: [] });
      return Promise.resolve({ _id: 'pod-1', name: 'Pod', members: [] });
    });
  });

  it('recovers a missed reply once and dedupes a socket copy received during the re-fetch', async () => {
    let resolveReconnect;
    const reconnectResponse = new Promise((resolve) => { resolveReconnect = resolve; });
    let reads = 0;
    mockApi.get.mockImplementation((url) => {
      if (url === '/api/messages/pod-1?limit=50') {
        reads += 1;
        return reads === 1 ? Promise.resolve([message('before-outage', 0)]) : reconnectResponse;
      }
      if (url.includes('/agents')) return Promise.resolve({ agents: [] });
      return Promise.resolve({ _id: 'pod-1', name: 'Pod', members: [] });
    });

    const { result, rerender } = renderHook(() => useV2PodDetail('pod-1'));
    await waitFor(() => expect(result.current.initialLoadComplete).toBe(true));
    expect(messageGets()).toHaveLength(1);

    act(() => { mockConnected = false; rerender(); });
    act(() => { mockConnected = true; rerender(); });
    await waitFor(() => expect(messageGets()).toHaveLength(2));

    const socketMessage = mockSocket.on.mock.calls
      .filter(([event]) => event === 'newMessage')
      .at(-1)[1];
    act(() => { socketMessage(message('socket-and-server', 2)); });
    await act(async () => {
      resolveReconnect([
        message('before-outage', 0),
        message('missed-reply', 1),
        message('socket-and-server', 2),
      ]);
      await reconnectResponse;
    });

    expect(result.current.messages.map((item) => item.id)).toEqual([
      'before-outage', 'missed-reply', 'socket-and-server',
    ]);
    expect(new Set(result.current.messages.map((item) => item.id)).size).toBe(3);
  });

  it('keeps a socket message the catch-up response does not contain', async () => {
    let resolveReconnect;
    const reconnectResponse = new Promise((resolve) => { resolveReconnect = resolve; });
    let reads = 0;
    mockApi.get.mockImplementation((url) => {
      if (url === '/api/messages/pod-1?limit=50') {
        reads += 1;
        return reads === 1 ? Promise.resolve([message('before-outage', 0)]) : reconnectResponse;
      }
      if (url.includes('/agents')) return Promise.resolve({ agents: [] });
      return Promise.resolve({ _id: 'pod-1', name: 'Pod', members: [] });
    });

    const { result, rerender } = renderHook(() => useV2PodDetail('pod-1'));
    await waitFor(() => expect(result.current.initialLoadComplete).toBe(true));
    expect(messageGets()).toHaveLength(1);

    act(() => { mockConnected = false; rerender(); });
    act(() => { mockConnected = true; rerender(); });
    await waitFor(() => expect(messageGets()).toHaveLength(2));

    const socketMessage = mockSocket.on.mock.calls
      .filter(([event]) => event === 'newMessage')
      .at(-1)[1];
    act(() => { socketMessage(message('socket-only', 3)); });
    await act(async () => {
      resolveReconnect([message('before-outage', 0), message('missed-reply', 1)]);
      await reconnectResponse;
    });

    expect(result.current.messages.map((item) => item.id)).toEqual([
      'before-outage', 'missed-reply', 'socket-only',
    ]);
  });

  it('does not fetch twice when the socket connects for the first time', async () => {
    mockConnected = false;
    const { result, rerender } = renderHook(() => useV2PodDetail('pod-1'));
    await waitFor(() => expect(result.current.initialLoadComplete).toBe(true));

    act(() => { mockConnected = true; rerender(); });
    expect(messageGets()).toHaveLength(1);
  });
});
