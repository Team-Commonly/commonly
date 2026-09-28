import { act, renderHook, waitFor } from '@testing-library/react';
import { useV2Pods } from '../hooks/useV2Pods';

const mockApi = {
  get: jest.fn(),
  post: jest.fn(),
  patch: jest.fn(),
  del: jest.fn(),
};

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => mockApi,
}));

const row = (createdAt: string) => ({
  _id: 'p1',
  name: 'Sharpen',
  lastMessage: { content: 'x', createdAt, username: 'a' },
});

// TASK-184. A poll that re-reads the sidebar's row times must not be
// observable as a state change: `loading` blanks the list into a spinner
// (V2PodsSidebar renders `v2-spinner` while loading), so a non-silent refresh
// on the minute tick would blink the whole sidebar once a minute, and a single
// failed poll would replace the last good rows with an error. Both arms are
// asserted here — silent, and the loud default that proves silent differs.
describe('useV2Pods silent refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('re-reads the list in place without entering the loading state', async () => {
    mockApi.get.mockResolvedValue([row('2026-09-28T04:00:00.000Z')]);
    const { result } = renderHook(() => useV2Pods());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let release: (value: unknown) => void = () => {};
    mockApi.get.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.refresh({ silent: true });
    });

    // In flight: the loud path is `true` here (next test), so this is the
    // observable difference the option buys.
    expect(result.current.loading).toBe(false);

    await act(async () => {
      release([row('2026-09-28T05:00:00.000Z')]);
      await pending;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.pods[0].lastMessage?.createdAt).toBe('2026-09-28T05:00:00.000Z');
  });

  it('keeps the last good rows and the last error when a silent read fails', async () => {
    mockApi.get.mockResolvedValue([row('2026-09-28T04:00:00.000Z')]);
    const { result } = renderHook(() => useV2Pods());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockApi.get.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      await result.current.refresh({ silent: true });
    });

    expect(result.current.error).toBeNull();
    expect(result.current.pods).toHaveLength(1);
    expect(result.current.pods[0].lastMessage?.createdAt).toBe('2026-09-28T04:00:00.000Z');
  });

  it('the loud default does enter the loading state and does surface a failure', async () => {
    mockApi.get.mockResolvedValue([row('2026-09-28T04:00:00.000Z')]);
    const { result } = renderHook(() => useV2Pods());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let release: (value: unknown) => void = () => {};
    mockApi.get.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.refresh();
    });
    expect(result.current.loading).toBe(true);
    await act(async () => {
      release([row('2026-09-28T05:00:00.000Z')]);
      await pending;
    });
    expect(result.current.loading).toBe(false);

    mockApi.get.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe('network down');
  });
});
