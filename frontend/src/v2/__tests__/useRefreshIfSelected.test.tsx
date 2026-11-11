import { renderHook } from '@testing-library/react';
import { useRefreshIfSelected } from '../hooks/useRefreshIfSelected';

describe('useRefreshIfSelected', () => {
  test('refreshes when the reply names the selected pod', () => {
    const refresh = jest.fn();
    const { result } = renderHook(() => useRefreshIfSelected('pod-1', refresh));
    result.current('pod-1');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('a late reply for a pod no longer selected refreshes nothing', () => {
    const first = jest.fn();
    const second = jest.fn();
    const { result, rerender } = renderHook(
      ({ podId, refresh }) => useRefreshIfSelected(podId, refresh),
      { initialProps: { podId: 'pod-1', refresh: first } },
    );
    const captured = result.current;
    rerender({ podId: 'pod-2', refresh: second });
    captured('pod-1');
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  test('a callback captured before a switch back still refreshes with the current pod\'s refresh', () => {
    const stale = jest.fn();
    const current = jest.fn();
    const { result, rerender } = renderHook(
      ({ podId, refresh }) => useRefreshIfSelected(podId, refresh),
      { initialProps: { podId: 'pod-1', refresh: stale } },
    );
    const captured = result.current;
    rerender({ podId: 'pod-1', refresh: current });
    captured('pod-1');
    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
  });

  test('no pod selected, or no refresh, does nothing', () => {
    const refresh = jest.fn();
    const { result } = renderHook(() => useRefreshIfSelected(null, refresh));
    result.current('pod-1');
    result.current('');
    expect(refresh).not.toHaveBeenCalled();
  });
});
