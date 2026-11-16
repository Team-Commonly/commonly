// A lazy chunk, or the CSS it brings, can fail to load. A tab opened before a
// deploy asks for files the new image no longer serves (prod answers a missing
// /assets/* with a 404 page), and a dropped connection fails the same way.
// Vite's preload helper reports both cases as a `vite:preloadError` event on
// window. We reload once, so the visitor gets the current build instead of a
// broken page.
//
// A tab reloads at most once per build. The guard records every build that
// has reloaded, not a time, so a chunk of a recorded build that keeps failing
// can't reload the tab again, however far apart the failures are. A tab left
// open across a deploy reloads once onto the new build, and that build gets
// its own one reload. During a rolling deploy, index.html and the chunks can
// come from pods on different builds; with every build recorded, the tab can't
// bounce between them (CodeRabbit on #4182, A -> B -> A). With no storage to
// record it, the tab doesn't reload at all.
//
// The handler never calls preventDefault. Vite then throws the original error
// as it would without us (the error boundary and Sentry see it), rather than
// resolving the import to undefined.

export const PRELOAD_RELOAD_KEY = 'commonly:preload-reloaded-builds';
export const MAX_RECORDED_BUILDS = 20;

type GuardStore = Pick<Storage, 'getItem' | 'setItem'>;

const recordedBuilds = (raw: string | null): string[] => {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((b): b is string => typeof b === 'string') : [];
  } catch {
    return [];
  }
};

export const shouldReloadAfterPreloadError = (store: GuardStore | null, build: string): boolean => {
  // With nowhere to record the reload, one more failure could loop the tab.
  if (!store) return false;
  try {
    const builds = recordedBuilds(store.getItem(PRELOAD_RELOAD_KEY));
    if (builds.includes(build)) return false;
    store.setItem(PRELOAD_RELOAD_KEY, JSON.stringify([...builds, build].slice(-MAX_RECORDED_BUILDS)));
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
