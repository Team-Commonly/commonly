import { act, renderHook, waitFor } from '@testing-library/react';
import { useV2PodHeaderMeta } from '../hooks/useV2PodHeaderMeta';

// A minimal socket: records handlers so a test can fire task_updated or connect.
const mockHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
const mockSocket = {
  on: jest.fn((event: string, fn: (...args: unknown[]) => void) => {
    (mockHandlers[event] = mockHandlers[event] || []).push(fn);
  }),
  off: jest.fn((event: string, fn: (...args: unknown[]) => void) => {
    mockHandlers[event] = (mockHandlers[event] || []).filter((h) => h !== fn);
  }),
};
const fire = (event: string, payload?: unknown) => {
  (mockHandlers[event] || []).forEach((fn) => fn(payload));
};
jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: mockSocket, connected: true, joinPod: jest.fn(), leavePod: jest.fn() }),
}));

const mockGet = jest.fn();
// One stable client object, like the real hook: a fresh object per render would
// re-run the effect after every state update and loop the reads.
const mockApi = { get: mockGet, post: jest.fn(), patch: jest.fn(), del: jest.fn() };
jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => mockApi,
}));

describe('useV2PodHeaderMeta', () => {
  beforeEach(() => {
    mockGet.mockReset();
    Object.keys(mockHandlers).forEach((k) => delete mockHandlers[k]);
  });

  const boardReads = () => mockGet.mock.calls.filter(([url]) => String(url).startsWith('/api/v1/tasks/')).length;

  test('counts open board rows (pending, claimed, in progress) and lists connected channels bound to this pod', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/tasks/')) {
        return Promise.resolve({ tasks: [{ status: 'pending' }, { status: 'claimed' }, { status: 'in_progress' }, { status: 'done' }] });
      }
      return Promise.resolve([
        { type: 'telegram', status: 'connected', podId: { _id: 'sharpen' } },
        { type: 'telegram', status: 'connected', podId: 'sharpen' },
        { type: 'slack', status: 'connected', podId: 'other' },
        { type: 'discord', status: 'pending', podId: 'sharpen' },
      ]);
    });
    const { result } = renderHook(() => useV2PodHeaderMeta('sharpen'));
    await waitFor(() => expect(result.current.boardOpen).toBe(3));
    expect(result.current.channels).toEqual(['telegram']);
  });

  test('a failed read leaves that fragment empty rather than blank-ing the header', async () => {
    mockGet.mockImplementation((url: string) => (url.startsWith('/api/v1/tasks/') ? Promise.reject(new Error('503')) : Promise.resolve('nope')));
    const { result } = renderHook(() => useV2PodHeaderMeta('sharpen'));
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    expect(result.current.boardOpen).toBeNull();
    expect(result.current.channels).toEqual([]);
  });

  test('no pod, no reads', () => {
    const { result } = renderHook(() => useV2PodHeaderMeta(null));
    expect(mockGet).not.toHaveBeenCalled();
    expect(result.current).toEqual({ boardOpen: null, channels: [] });
  });

  test('a task_updated for this pod re-reads the open count without a reload', async () => {
    let open = 1;
    mockGet.mockImplementation((url: string) => (url.startsWith('/api/v1/tasks/')
      ? Promise.resolve({ tasks: Array.from({ length: open }, () => ({ status: 'pending' })) })
      : Promise.resolve([])));
    const { result } = renderHook(() => useV2PodHeaderMeta('sharpen'));
    await waitFor(() => expect(result.current.boardOpen).toBe(1));
    open = 4;
    await act(async () => { fire('task_updated', { podId: 'sharpen' }); });
    await waitFor(() => expect(result.current.boardOpen).toBe(4));
  });

  test('a task_updated for another pod leaves this header alone', async () => {
    mockGet.mockImplementation((url: string) => (url.startsWith('/api/v1/tasks/')
      ? Promise.resolve({ tasks: [{ status: 'pending' }] })
      : Promise.resolve([])));
    const { result } = renderHook(() => useV2PodHeaderMeta('sharpen'));
    await waitFor(() => expect(result.current.boardOpen).toBe(1));
    const before = boardReads();
    await act(async () => { fire('task_updated', { podId: 'other' }); });
    expect(boardReads()).toBe(before);
  });

  test('a reconnect re-reads the open count, since a task update may have been missed', async () => {
    mockGet.mockImplementation((url: string) => (url.startsWith('/api/v1/tasks/')
      ? Promise.resolve({ tasks: [{ status: 'claimed' }] })
      : Promise.resolve([])));
    const { result } = renderHook(() => useV2PodHeaderMeta('sharpen'));
    await waitFor(() => expect(result.current.boardOpen).toBe(1));
    const before = boardReads();
    await act(async () => { fire('connect'); });
    expect(boardReads()).toBe(before + 1);
  });

  test('a slower earlier read cannot overwrite a newer count', async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    mockGet.mockImplementation((url: string) => (url.startsWith('/api/v1/tasks/')
      ? new Promise((resolve) => { resolvers.push(resolve); })
      : Promise.resolve([])));
    const { result } = renderHook(() => useV2PodHeaderMeta('sharpen'));
    await waitFor(() => expect(resolvers).toHaveLength(1));
    await act(async () => { fire('task_updated', { podId: 'sharpen' }); });
    expect(resolvers).toHaveLength(2);
    await act(async () => { resolvers[1]({ tasks: [{ status: 'pending' }, { status: 'pending' }] }); });
    await waitFor(() => expect(result.current.boardOpen).toBe(2));
    await act(async () => { resolvers[0]({ tasks: [{ status: 'pending' }] }); });
    expect(result.current.boardOpen).toBe(2);
  });
});
