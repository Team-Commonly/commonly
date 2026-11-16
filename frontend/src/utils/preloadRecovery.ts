// A lazy chunk, or the CSS it brings, can fail to load. A tab opened before a
// deploy asks for files the new image no longer serves (prod answers a missing
// /assets/* with a 404 page), and a dropped connection fails the same way.
// Vite's preload helper reports both cases as a `vite:preloadError` event on
// window. We reload once, so the visitor gets the current build instead of a
// broken page.
//
// A tab reloads at most once per build. The guard records the build that
// reloaded, not a time, so a chunk of this build that keeps failing can't
// reload the tab again, however far apart the failures are. A tab left open
// across a deploy reloads once onto the new build, and that build gets its own
// one reload. With no storage to record it, the tab doesn't reload at all.
//
// The handler never calls preventDefault. Vite then throws the original error
// as it would without us (the error boundary and Sentry see it), rather than
// resolving the import to undefined.

export const PRELOAD_RELOAD_KEY = 'commonly:preload-reloaded-build';

type GuardStore = Pick<Storage, 'getItem' | 'setItem'>;

export const shouldReloadAfterPreloadError = (store: GuardStore | null, build: string): boolean => {
  // With nowhere to record the reload, one more failure could loop the tab.
  if (!store) return false;
  try {
    if (store.getItem(PRELOAD_RELOAD_KEY) === build) return false;
    store.setItem(PRELOAD_RELOAD_KEY, build);
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

// The release the build was cut from (Sentry reports the same value). A local
// build without one shares a single key, so it still reloads once at most.
const currentBuild = (): string => process.env.REACT_APP_VERSION || 'unversioned';

interface PreloadRecoveryOptions {
  reload?: () => void;
  build?: string;
}

export const installPreloadRecovery = ({
  reload = () => window.location.reload(),
  build = currentBuild(),
}: PreloadRecoveryOptions = {}): (() => void) => {
  const onPreloadError = () => {
    if (shouldReloadAfterPreloadError(sessionStore(), build)) reload();
  };
  window.addEventListener('vite:preloadError', onPreloadError);
  return () => window.removeEventListener('vite:preloadError', onPreloadError);
};
