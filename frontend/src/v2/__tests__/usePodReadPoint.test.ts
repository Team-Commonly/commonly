// @ts-nocheck
// A busy pod reaches its end on every arrival; the read point PUTs stay at
// one per window, carry the latest point, and flush when the pod changes.
import { act, renderHook } from '@testing-library/react';
import { usePodReadPoint, READ_POINT_PUT_WINDOW_MS } from '../hooks/usePodReadPoint';

const mockPut = jest.fn(() => Promise.resolve({}));
const mockApi = { get: jest.fn(() => Promise.resolve({ lastReadAt: null })), put: (...a) => mockPut(...a) };
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => mockApi }));

const at = (min) => `2026-11-14T10:${String(min).padStart(2, '0')}:00.000Z`;
beforeEach(() => { jest.useFakeTimers(); mockPut.mockClear(); });
afterEach(() => { jest.useRealTimers(); });

test('the first move goes at once; moves inside the window coalesce into one PUT with the latest point', () => {
  const { result } = renderHook(() => usePodReadPoint('p1'));
  act(() => result.current.markRead(at(1)));
  expect(mockPut).toHaveBeenCalledTimes(1);
  act(() => { result.current.markRead(at(2)); result.current.markRead(at(3)); result.current.markRead(at(4)); });
  expect(mockPut).toHaveBeenCalledTimes(1);
  act(() => { jest.advanceTimersByTime(READ_POINT_PUT_WINDOW_MS); });
  expect(mockPut).toHaveBeenCalledTimes(2);
  expect(mockPut.mock.calls[1]).toEqual(['/api/pods/p1/read-point', { at: at(4) }]);
});

test('an older or equal point sends nothing', () => {
  const { result } = renderHook(() => usePodReadPoint('p1'));
  act(() => result.current.markRead(at(5)));
  act(() => { result.current.markRead(at(5)); result.current.markRead(at(2)); jest.advanceTimersByTime(READ_POINT_PUT_WINDOW_MS); });
  expect(mockPut).toHaveBeenCalledTimes(1);
});

test('switching pods sends the held point for the pod being left, and the next pod starts fresh', () => {
  const { result, rerender } = renderHook(({ pod }) => usePodReadPoint(pod), { initialProps: { pod: 'p1' } });
  act(() => result.current.markRead(at(1)));
  act(() => result.current.markRead(at(6)));
  rerender({ pod: 'p2' });
  expect(mockPut.mock.calls[1]).toEqual(['/api/pods/p1/read-point', { at: at(6) }]);
  act(() => result.current.markRead(at(7)));
  expect(mockPut.mock.calls[2]).toEqual(['/api/pods/p2/read-point', { at: at(7) }]);
});
