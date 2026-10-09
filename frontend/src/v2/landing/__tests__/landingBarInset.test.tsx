import React from 'react';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../../../context/AuthContext';
import V2LandingPage from '../V2LandingPage';

/**
 * TASK-167 row A (TASK-192), sprint-review's finding at `9d02f549`.
 *
 * The hero's demo band ends where the bar stops overlapping it, and the bar is
 * 72 tall at 1440 and 64 at ≤680 — so the switch hard-coded at 72 turned the
 * bar white 8px early on a phone (ux-lead's finding 8). The fix is a pair: a
 * layout effect that measures the bar, and an observer effect keyed on that
 * measurement, because `rootMargin` is read once when the observer is built
 * and cannot be mutated on a live one.
 *
 * The four mutations below were all GREEN against the source pins that shipped
 * with the fix, and `}, [barHeight]);` → `}, []);` is the defect itself: the
 * observer is then built once with `barHeight` still 0, the `|| 72` fallback
 * gives 72, and the measured 64 never re-arms it. A source pin cannot see the
 * difference — both spellings read `rootMargin: \`-${barHeight || 72}px …\`` —
 * so the dependency is pinned by BEHAVIOUR: change the measured height, fire
 * the resize the component listens for, and assert the observer was rebuilt
 * with the new inset.
 *
 * jsdom has no layout, so `offsetHeight` is stubbed here for the same reason
 * the component measures it in a browser: 0 is the only height jsdom reports.
 */

jest.mock('axios');
jest.mock('../../../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockAxiosGet = axios.get as jest.Mock;
const mockUseAuth = useAuth as jest.Mock;

/** Every observer the component built, oldest first: `[rootMargin, observed]`. */
type Arming = { rootMargin: string | undefined; observed: Element | undefined };

const armings: Arming[] = [];

class CapturingObserver {
  readonly rootMargin: string | undefined;

  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.rootMargin = options?.rootMargin;
    armings.push({ rootMargin: options?.rootMargin, observed: undefined });
  }

  observe(el: Element): void {
    armings[armings.length - 1].observed = el;
  }

  unobserve(): void {}

  disconnect(): void {}

  takeRecords(): IntersectionObserverEntry[] { return []; }

  // Deliberately never called: the stubbed observer's silence is why every
  // render test stays on the band, and these tests are about arming.
  readonly root = null;

  readonly rootMargin_: string = '';

  readonly thresholds: number[] = [];

  invoke(entry: Partial<IntersectionObserverEntry>): void {
    this.callback([entry as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

/** The bar's height, as the stubbed layout would report it. */
let barHeight = 0;

const originalOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetHeight',
);

const renderLanding = () => render(
  <MemoryRouter>
    <V2LandingPage />
  </MemoryRouter>,
);

/**
 * The bar's observer: selected by the element it watches, not by recency.
 * The page builds other observers too (the scroll-reveal gate, `rootMargin:
 * '0px 0px -8% 0px'`), and one of those is built last, so "the newest
 * observer" is not this row's.
 */
const barArming = () => armings.filter(
  (a) => (a.observed as HTMLElement | undefined)?.className?.includes('v2-landing__hero'),
);

describe('the landing bar inset is measured, and the observer re-arms on a change (TASK-167 row A)', () => {
  beforeAll(() => {
    (global as unknown as Record<string, unknown>).IntersectionObserver = CapturingObserver;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() { return barHeight; },
    });
  });

  afterAll(() => {
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
    }
  });

  beforeEach(() => {
    armings.length = 0;
    barHeight = 0;
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ isAuthenticated: false });
    mockAxiosGet.mockResolvedValue({ data: {} });
  });

  it('arms the observer with the MEASURED bar, not the 72 fallback', () => {
    barHeight = 64;
    renderLanding();

    // ≥3 and not exactly 3: the page has other observers (the scroll-reveal
    // gate), and this row must not be pinned to their count.
    const bar = barArming();
    expect(bar.length).toBeGreaterThan(0);
    expect(bar[bar.length - 1].rootMargin).toBe('-64px 0px 0px 0px');
  });

  it('falls back to 72 while the bar has not laid out', () => {
    barHeight = 0;
    renderLanding();

    const bar = barArming();
    expect(bar[bar.length - 1].rootMargin).toBe('-72px 0px 0px 0px');
  });

  it('rebuilds the observer when a resize crosses the bar height', () => {
    // THE PIN FOR `}, [barHeight]);`. With an empty dependency list the build
    // below never happens: one observer, armed at 72, for the page's life.
    barHeight = 72;
    renderLanding();
    expect(barArming()[0].rootMargin).toBe('-72px 0px 0px 0px');
    const builtBefore = barArming().length;

    barHeight = 64;
    act(() => { window.dispatchEvent(new Event('resize')); });

    expect(barArming().length).toBeGreaterThan(builtBefore);
    expect(barArming()[builtBefore].rootMargin).toBe('-64px 0px 0px 0px');
  });

  it('ignores a resize that does not move the bar, so it does not churn', () => {
    // `setBarHeight` with an unchanged number is an Object.is bail-out: no
    // render, no new observer, no disconnect/observe on every resize event.
    barHeight = 64;
    renderLanding();
    const built = barArming().length;

    act(() => { window.dispatchEvent(new Event('resize')); });

    expect(barArming().length).toBe(built);
  });

  it('removes the resize listener on unmount', () => {
    // The same five mutations: deleting the cleanup entirely was green too.
    // Asserted by identity, not by count, because the removal that matters is
    // the one unbinding THIS function.
    const add = jest.spyOn(window, 'addEventListener');
    const remove = jest.spyOn(window, 'removeEventListener');
    try {
      const view = renderLanding();
      const call = add.mock.calls.find(([type]) => type === 'resize');
      expect(call).toBeDefined();
      const handler = call?.[1];

      view.unmount();

      expect(remove).toHaveBeenCalledWith('resize', handler);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});
