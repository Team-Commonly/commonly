import { renderHook, waitFor } from '@testing-library/react';
import { useV2PodHeaderMeta } from '../hooks/useV2PodHeaderMeta';

const mockGet = jest.fn();
jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({ get: mockGet, post: jest.fn(), patch: jest.fn(), del: jest.fn() }),
}));

describe('useV2PodHeaderMeta', () => {
  beforeEach(() => mockGet.mockReset());

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
});
