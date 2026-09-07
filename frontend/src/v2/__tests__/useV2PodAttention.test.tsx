import { act, renderHook, waitFor } from '@testing-library/react';
import { useV2PodAttention, notifyAttentionChanged } from '../hooks/useV2PodAttention';

const mockGet = jest.fn();
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => ({ get: mockGet }) }));

test('uses uncapped endpoint totals even when a pod has no displayed cards, and refreshes after resolution', async () => {
  mockGet.mockResolvedValue({ items: [], count: 91, countsByPod: { hidden: 91 } });
  const { result } = renderHook(() => useV2PodAttention());
  await waitFor(() => expect(result.current.count).toBe(91));
  expect(result.current.countByPod).toEqual({ hidden: 91 });
  mockGet.mockResolvedValue({ items: [], count: 0, countsByPod: {} });
  act(() => { notifyAttentionChanged(); });
  await waitFor(() => expect(result.current.count).toBe(0));
  expect(result.current.countByPod).toEqual({});
});

test('an unavailable queue is unknown, not an invented zero', async () => {
  mockGet.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useV2PodAttention());
  await act(async () => {});
  expect(result.current.count).toBeNull();
  expect(result.current.items).toEqual([]);
});
