import type { Session } from './session';

/**
 * A failed API call. `code` is the backend's stable error code when it sent
 * one (e.g. 'summary_unavailable', 'dm_membership_refused'); `message` is
 * whatever it said; `status` is the HTTP status. Callers branch on `status`
 * and `code`, never on message text.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    super(String(b.message || b.error || `HTTP ${status}`));
    this.name = 'ApiError';
    this.status = status;
    this.code = typeof b.error === 'string' && !b.message ? b.error : (typeof b.code === 'string' ? b.code : null);
    this.body = body;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Skip the Authorization header (login, register, public stats). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

/**
 * The HTTP client. One function, fetch-based, no singleton: every call reads
 * the token from the Session at call time, so sign-in and sign-out take
 * effect immediately and the same core serves several sessions in one
 * process (the desktop shell will).
 */
export class Api {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly session: Session, fetchImpl?: typeof fetch) {
    // Bind to the global: a bare `fetch` reference invoked as a method throws
    // "Illegal invocation" in browsers. Tests pass their own implementation.
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (!options.anonymous) {
      const token = await this.session.token();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const res = await this.fetchImpl(`${this.session.baseUrl}${path}`, {
      method: options.method || (options.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = { message: text.slice(0, 200) }; }
    }
    if (!res.ok) {
      if (res.status === 401 && !options.anonymous) await this.session.setToken(null);
      throw new ApiError(res.status, parsed);
    }
    return parsed as T;
  }

  get<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...options, method: 'POST', body: body ?? {} });
  }

  patch<T>(path: string, body: unknown, options: Omit<RequestOptions, 'method' | 'body'> = {}) {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }
}
