/**
 * Session: the one place the token lives.
 *
 * The old shell read `localStorage.getItem('token')` from six different files
 * and set the HTTP client's base URL at module load, so nothing in it could be
 * imported by a desktop or mobile shell. Here the token store is injected:
 * the web app passes a localStorage-backed store, the Tauri shell passes the
 * OS keychain, tests pass memory. Nothing else in the core touches storage.
 */

export interface TokenStore {
  get(): string | null | Promise<string | null>;
  set(token: string | null): void | Promise<void>;
}

export const memoryTokenStore = (initial: string | null = null): TokenStore => {
  let value = initial;
  return {
    get: () => value,
    set: (token) => { value = token; },
  };
};

/** Web adapter. Wraps every access in try/catch: private windows and blocked storage throw. */
export const webTokenStore = (key = 'token'): TokenStore => ({
  get: () => {
    try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
  },
  set: (token) => {
    try {
      if (token) globalThis.localStorage?.setItem(key, token);
      else globalThis.localStorage?.removeItem(key);
    } catch { /* storage unavailable: the session lives in memory for this tab */ }
  },
});

export interface SessionConfig {
  /** API origin, e.g. https://api.commonly.me — no trailing slash. */
  baseUrl: string;
  store: TokenStore;
}

export class Session {
  readonly baseUrl: string;
  private readonly store: TokenStore;
  private listeners = new Set<(token: string | null) => void>();

  constructor(config: SessionConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.store = config.store;
  }

  async token(): Promise<string | null> {
    return this.store.get();
  }

  async setToken(token: string | null): Promise<void> {
    await this.store.set(token);
    this.listeners.forEach((fn) => fn(token));
  }

  /** Fires on sign-in and sign-out. Returns an unsubscribe. */
  onChange(fn: (token: string | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
