import fs from 'fs';
import path from 'path';
import {
  installPreloadRecovery,
  PRELOAD_RELOAD_KEY,
  PRELOAD_RELOAD_WINDOW_MS,
  shouldReloadAfterPreloadError,
} from './preloadRecovery';

const memoryStore = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
};

const preloadError = () => new Event('vite:preloadError', { cancelable: true });

describe('shouldReloadAfterPreloadError', () => {
  it('reloads on the first failure and records when', () => {
    const store = memoryStore();
    expect(shouldReloadAfterPreloadError(store, 1_000_000)).toBe(true);
    expect(store.getItem(PRELOAD_RELOAD_KEY)).toBe('1000000');
  });

  it('does not reload again inside the window, so a missing file cannot loop', () => {
    const store = memoryStore();
    shouldReloadAfterPreloadError(store, 1_000_000);
    expect(shouldReloadAfterPreloadError(store, 1_000_000 + PRELOAD_RELOAD_WINDOW_MS - 1)).toBe(false);
  });

  it('reloads again once the window has passed (the next deploy)', () => {
    const store = memoryStore();
    shouldReloadAfterPreloadError(store, 1_000_000);
    expect(shouldReloadAfterPreloadError(store, 1_000_000 + PRELOAD_RELOAD_WINDOW_MS)).toBe(true);
  });

  it('treats a corrupt stored value as no previous reload', () => {
    const store = memoryStore();
    store.setItem(PRELOAD_RELOAD_KEY, 'not-a-number');
    expect(shouldReloadAfterPreloadError(store, 1_000_000)).toBe(true);
    store.setItem(PRELOAD_RELOAD_KEY, '-5');
    expect(shouldReloadAfterPreloadError(store, 2_000_000)).toBe(true);
  });

  it('holds a stamp from the future (a clock step back) until the window passes it: no reload, never a loop', () => {
    const store = memoryStore();
    store.setItem(PRELOAD_RELOAD_KEY, String(1_000_000 + 30_000));
    expect(shouldReloadAfterPreloadError(store, 1_000_000)).toBe(false);
    expect(shouldReloadAfterPreloadError(store, 1_000_000 + 30_000 + PRELOAD_RELOAD_WINDOW_MS)).toBe(true);
  });

  it('does not reload when there is no storage to guard the loop with', () => {
    expect(shouldReloadAfterPreloadError(null, 1_000_000)).toBe(false);
  });

  it('does not reload when storage throws', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(shouldReloadAfterPreloadError(throwing, 1_000_000)).toBe(false);
  });

  it('does not reload when the guard cannot be written', () => {
    const readOnly = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(shouldReloadAfterPreloadError(readOnly, 1_000_000)).toBe(false);
  });
});

describe('installPreloadRecovery', () => {
  beforeEach(() => { window.sessionStorage.clear(); });

  it('reloads once when Vite reports a failed chunk or CSS preload, and leaves the error to throw', () => {
    const reload = jest.fn();
    const uninstall = installPreloadRecovery({ reload, now: () => 5_000_000 });
    const first = preloadError();
    window.dispatchEvent(first);
    expect(reload).toHaveBeenCalledTimes(1);
    // Not prevented: Vite still throws the original error, so the error boundary and Sentry see it.
    expect(first.defaultPrevented).toBe(false);

    window.dispatchEvent(preloadError());
    expect(reload).toHaveBeenCalledTimes(1);
    uninstall();
  });

  // Structural check, on purpose: "installed before the first lazy import" is an
  // ordering in the entry file that no jsdom run can show (review-checklist rule 18).
  // The real-browser proof is in the PR that added this file.
  it('is installed by the app entry before its first lazy import', () => {
    const entry = fs.readFileSync(path.join(__dirname, '..', 'index.tsx'), 'utf8');
    const install = entry.indexOf('\ninstallPreloadRecovery();');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(entry.indexOf('import('));
  });

  it('stops listening after uninstall', () => {
    const reload = jest.fn();
    installPreloadRecovery({ reload, now: () => 9_000_000 })();
    window.dispatchEvent(preloadError());
    expect(reload).not.toHaveBeenCalled();
  });
});
