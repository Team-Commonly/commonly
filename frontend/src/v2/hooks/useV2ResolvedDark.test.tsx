import { act, renderHook } from '@testing-library/react';
import { useV2ResolvedDark } from './useV2ResolvedDark';

describe('useV2ResolvedDark', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-v2-theme');
  });

  test('follows data-v2-theme as it changes, without a reload', async () => {
    // jsdom has no matchMedia, so the OS reads as light and only the attribute moves the result.
    const { result } = renderHook(() => useV2ResolvedDark());
    expect(result.current).toBe(false);

    await act(async () => {
      document.documentElement.setAttribute('data-v2-theme', 'dark');
    });
    expect(result.current).toBe(true);

    await act(async () => {
      document.documentElement.setAttribute('data-v2-theme', 'light');
    });
    expect(result.current).toBe(false);
  });
});
