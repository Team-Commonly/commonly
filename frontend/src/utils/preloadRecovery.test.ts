import fs from 'fs';
import path from 'path';
import {
  installPreloadRecovery,
  MAX_RECORDED_BUILDS,
  PRELOAD_RELOAD_KEY,
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
  it('reloads on the first failure and records the build', () => {
    const store = memoryStore();
    expect(shouldReloadAfterPreloadError(store, 'build-a')).toBe(true);
    expect(JSON.parse(store.getItem(PRELOAD_RELOAD_KEY) as string)).toEqual(['build-a']);
  });

  it('never reloads the same build twice, however far apart the failures are', () => {
    // CodeRabbit on #4182: a time window let a chunk that fails more than a
    // minute after each load reload the tab every cycle. Time no longer counts.
    const store = memoryStore();
    shouldReloadAfterPreloadError(store, 'build-a');
    expect(shouldReloadAfterPreloadError(store, 'build-a')).toBe(false);
    expect(shouldReloadAfterPreloadError(store, 'build-a')).toBe(false);
  });

  it('gives a new build its own one reload (a tab left open across a deploy)', () => {
    const store = memoryStore();
    shouldReloadAfterPreloadError(store, 'build-a');
    expect(shouldReloadAfterPreloadError(store, 'build-b')).toBe(true);
    expect(shouldReloadAfterPreloadError(store, 'build-b')).toBe(false);
  });

  it('does not reload a build again after another build came between (A -> B -> A)', () => {
    // CodeRabbit on #4182: keeping only the latest build let a rollback, or a
    // rolling deploy serving index.html and chunks from pods on different
    // builds, bounce the tab between them.
    const store = memoryStore();
    expect(shouldReloadAfterPreloadError(store, 'build-a')).toBe(true);
    expect(shouldReloadAfterPreloadError(store, 'build-b')).toBe(true);
    expect(shouldReloadAfterPreloadError(store, 'build-a')).toBe(false);
    expect(shouldReloadAfterPreloadError(store, 'build-b')).toBe(false);
  });

  it(`keeps at most ${MAX_RECORDED_BUILDS} builds, dropping the oldest`, () => {
    const store = memoryStore();
    for (let i = 0; i <= MAX_RECORDED_BUILDS; i += 1) shouldReloadAfterPreloadError(store, `build-${i}`);
    const kept = JSON.parse(store.getItem(PRELOAD_RELOAD_KEY) as string);
    expect(kept).toHaveLength(MAX_RECORDED_BUILDS);
    expect(kept).not.toContain('build-0');
    expect(shouldReloadAfterPreloadError(store, `build-${MAX_RECORDED_BUILDS}`)).toBe(false);
  });

  it('treats an unknown stored value as no previous reload', () => {
    const store = memoryStore();
    store.setItem(PRELOAD_RELOAD_KEY, '{"corrupt":');
    expect(shouldReloadAfterPreloadError(store, 'build-a')).toBe(true);
    store.setItem(PRELOAD_RELOAD_KEY, '"build-a"');
    expect(shouldReloadAfterPreloadError(store, 'build-b')).toBe(true);
  });

  it('does not reload when there is no storage to guard the loop with', () => {
    expect(shouldReloadAfterPreloadError(null, 'build-a')).toBe(false);
  });

  it('does not reload when storage throws', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(shouldReloadAfterPreloadError(throwing, 'build-a')).toBe(false);
  });

  it('does not reload when the guard cannot be written', () => {
    const readOnly = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(shouldReloadAfterPreloadError(readOnly, 'build-a')).toBe(false);
  });
});

describe('installPreloadRecovery', () => {
  beforeEach(() => { window.sessionStorage.clear(); });

  it('reloads once when Vite reports a failed chunk or CSS preload, and leaves the error to throw', () => {
    const reload = jest.fn();
    const uninstall = installPreloadRecovery({ reload, build: 'build-a' });
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
    installPreloadRecovery({ reload, build: 'build-a' })();
    window.dispatchEvent(preloadError());
    expect(reload).not.toHaveBeenCalled();
  });
});
