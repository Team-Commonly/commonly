// @ts-nocheck
// F576: the kernel rewrites a message in place (an agent's install intro, on
// its first listen) and tells the pod over `messageUpdated`. The open thread
// merges whichever of content and payload the event carries.
import { act, renderHook, waitFor } from '@testing-library/react';
import { useV2PodDetail } from '../hooks/useV2PodDetail';

const mockApi = { get: jest.fn(), post: jest.fn() };
const mockSocket = { on: jest.fn(), off: jest.fn() };
const mockJoinPod = jest.fn();
const mockLeavePod = jest.fn();

jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));
jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: mockSocket, connected: true, joinPod: mockJoinPod, leavePod: mockLeavePod }),
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
});
