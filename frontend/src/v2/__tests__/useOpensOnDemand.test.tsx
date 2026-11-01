import { renderHook, act } from '@testing-library/react';
import { useOpensOnDemand } from '../hooks/useOpensOnDemand';

type Demands = { a: unknown; b?: unknown };
const render = (initial: Demands) => renderHook(({ a, b }: Demands) => useOpensOnDemand(a, b), { initialProps: initial });

describe('useOpensOnDemand', () => {
  it('starts open when a demand already holds, closed otherwise', () => {
    expect(render({ a: 'error' }).result.current[0]).toBe(true);
    expect(render({ a: null }).result.current[0]).toBe(false);
  });

  it('stays closed while the demand holds after the reader closes it, and reopens when it rises again', () => {
    const { result, rerender } = render({ a: null });
    rerender({ a: 'error' });
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    rerender({ a: 'error' });
    expect(result.current[0]).toBe(false);
    rerender({ a: null });
    rerender({ a: 'again' });
    expect(result.current[0]).toBe(true);
  });

  it('a second demand rising opens the panel even while the first still holds', () => {
    const { result, rerender } = render({ a: 'confirm', b: null });
    act(() => result.current[1](false));
    rerender({ a: 'confirm', b: 'key' });
    expect(result.current[0]).toBe(true);
  });
});
