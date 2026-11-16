// A lazy chunk, or the CSS it brings, can fail to load. A tab opened before a
// deploy asks for files the new image no longer serves (prod answers a missing
// /assets/* with a 404 page), and a dropped connection fails the same way.
// Vite's preload helper reports both cases as a `vite:preloadError` event on
// window. We reload once, so the visitor gets the current build instead of a
// broken page. A second failure inside the window doesn't reload again: a file
// that is really gone can't put the tab in a loop, and the error still throws,
// so the error boundary and Sentry see it.
//
// The handler never calls preventDefault. Vite then throws the original error
// as it would without us, rather than resolving the import to undefined.

export const PRELOAD_RELOAD_KEY = 'commonly:preload-reload-at';
export const PRELOAD_RELOAD_WINDOW_MS = 60_000;

type GuardStore = Pick<Storage, 'getItem' | 'setItem'>;

export const shouldReloadAfterPreloadError = (store: GuardStore | null, now: number): boolean => {
  // With nowhere to record the reload, one more failure could loop the tab.
  if (!store) return false;
  try {
    const last = Number(store.getItem(PRELOAD_RELOAD_KEY));
    if (last > 0 && now - last < PRELOAD_RELOAD_WINDOW_MS) return false;
    store.setItem(PRELOAD_RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
};

const sessionStore = (): GuardStore | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

interface PreloadRecoveryOptions {
  reload?: () => void;
  now?: () => number;
}

export const installPreloadRecovery = ({
  reload = () => window.location.reload(),
  now = () => Date.now(),
}: PreloadRecoveryOptions = {}): (() => void) => {
  const onPreloadError = () => {
    if (shouldReloadAfterPreloadError(sessionStore(), now())) reload();
  };
  window.addEventListener('vite:preloadError', onPreloadError);
  return () => window.removeEventListener('vite:preloadError', onPreloadError);
};
