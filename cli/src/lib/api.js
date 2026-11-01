/**
 * CAP HTTP client — thin wrapper over fetch.
 *
 * Every method reads the active instance URL and token from config
 * unless overridden. This is the only place that makes HTTP calls.
 */

import { resolveInstanceUrl, getToken, resolveInstance } from './config.js';

const headers = (token, extra = {}) => ({
  'Content-Type': 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...extra,
});

const knownSessionFailure = (body) => [body?.msg, body?.error, body?.message]
  .some((value) => ['Token is not valid', 'Invalid API token', 'Account no longer exists'].includes(value));

export const sessionExpiredMessage = ({ instanceKey, baseUrl }) => (
  `Session for ${instanceKey} (${baseUrl}) has expired.\nRun: commonly login --instance ${instanceKey}`
);

// A non-JSON error body is usually an edge proxy's HTML page; a Cloudflare
// tunnel error is ~120 lines, and the message used to be all of them, so every
// failed poll dumped a whole page into the agent log. The message names the
// page by its <title>; err.body keeps the full text for callers that classify it.
const MAX_TEXT_ERROR = 300;
const summarizeTextError = (text, status) => {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  if (/^<(?:!doctype|html)/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) {
    const title = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
    return title ? `HTTP ${status}: ${title}` : `HTTP ${status} (HTML error page)`;
  }
  const line = trimmed.replace(/\s+/g, ' ');
  return line.length > MAX_TEXT_ERROR ? `${line.slice(0, MAX_TEXT_ERROR)}…` : line;
};

const handleResponse = async (res, session = null) => {
  const text = await res.text();
  let body;
  let isJson = true;
  try { body = JSON.parse(text); } catch { body = { message: text }; isJson = false; }
  if (!res.ok) {
    const serverMessage = isJson
      ? body?.error || body?.message || body?.msg
      : summarizeTextError(text, res.status);
    const msg = res.status === 401 && session && knownSessionFailure(body)
      ? sessionExpiredMessage(session)
      : serverMessage || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
};

// TASK-338: every CAP request carries a hard timeout. Without one, a request
// that a proxy or the network accepts and never answers leaves its promise
// pending for good, and the run loop awaiting it is alive but wedged: nib and
// folio each sat 8+ hours on one unanswered poll on 10-31, and their keepalives,
// which respawn only on exit, could not see it. The poll-retry backoff
// (TASK-025) only handles a fetch that throws, so a timeout throws: it is an
// ordinary failed request, retried with backoff, and never an ack.
//
// Reads get the base timeout; writes and uploads carry a body and a server-side
// write, so they get a multiple of it. COMMONLY_CAP_TIMEOUT_MS sets the base.
export const CAP_TIMEOUT_DEFAULT_MS = 30_000;
const TIMEOUT_SCALE = { read: 1, write: 2, upload: 4 };

export const capTimeoutMs = (kind, { baseMs, env = process.env } = {}) => {
  const fromEnv = Number(env.COMMONLY_CAP_TIMEOUT_MS);
  const base = [baseMs, fromEnv].find((value) => Number.isFinite(value) && value > 0)
    ?? CAP_TIMEOUT_DEFAULT_MS;
  return Math.min(base * (TIMEOUT_SCALE[kind] || 1), 2_147_483_647);
};

// A caller's own signal (doctor, and the 5s identity and skills reads in the
// run loop) still applies; the hard timeout is added beside it, never instead.
// AbortSignal.any is Node 20.3+, and `engines` allows 20.0, so the fallback
// joins the two by hand. Either way the abort carries the source's own reason,
// which is what nameTimeout matches on.
// The fallback's listeners are removed when the request settles, so a caller
// that reuses one long-lived signal does not collect one per request.
const capSignal = (capTimeout, callerSignal) => {
  if (!callerSignal) return { signal: capTimeout, release: () => {} };
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([callerSignal, capTimeout]), release: () => {} };
  }
  const joined = new AbortController();
  const listeners = [];
  for (const source of [callerSignal, capTimeout]) {
    if (source.aborted) {
      joined.abort(source.reason);
      break;
    }
    const onAbort = () => joined.abort(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    listeners.push([source, onAbort]);
  }
  return {
    signal: joined.signal,
    release: () => listeners.forEach(([source, onAbort]) => source.removeEventListener('abort', onAbort)),
  };
};

export const formatLimit = (ms) => (ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`);

// The cap's timeout rejects with a DOMException named TimeoutError, from the
// fetch or from the body read. Name the request and the limit instead, so the
// log line reads as an unanswered request rather than "operation was aborted".
// Only the cap's own timeout is renamed: a caller's abort or its own shorter
// timeout passes through as it was thrown.
const nameTimeout = (capTimeout, method, path, ms) => (err) => {
  // By identity: the caller's timeout can fire first and the cap's a moment
  // later, and then `capTimeout.aborted` alone would claim the caller's error.
  if (err?.name !== 'TimeoutError' || err !== capTimeout.reason) throw err;
  throw Object.assign(
    new Error(`${method} ${path} got no answer in ${formatLimit(ms)}`),
    { code: 'cap_timeout', timeoutMs: ms },
  );
};

const timedFetch = (url, init, { method, path, ms, session }) => {
  const capTimeout = AbortSignal.timeout(ms);
  const { signal, release } = capSignal(capTimeout, init.signal);
  return fetch(url, { ...init, signal })
    .then((res) => handleResponse(res, session))
    .catch(nameTimeout(capTimeout, method, path, ms))
    .finally(release);
};

export const createClient = ({ instance = null, token = undefined, timeoutMs = undefined } = {}) => {
  const baseUrl = resolveInstanceUrl(instance);
  const resolved = resolveInstance(instance);
  const authToken = token === undefined ? getToken(instance) : token;
  const session = {
    instanceKey: resolved?.key || (typeof instance === 'string' && instance && !/^https?:\/\//i.test(instance) ? instance : 'default'),
    baseUrl,
  };
  const limit = (kind) => capTimeoutMs(kind, { baseMs: timeoutMs });

  const get = (path, params = {}, options = {}) => {
    const url = new URL(`${baseUrl}${path}`);
    Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
    return timedFetch(url.toString(), { headers: headers(authToken), ...options }, {
      method: 'GET', path, ms: limit('read'), session,
    });
  };

  const post = (path, body = {}) => timedFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: headers(authToken),
    body: JSON.stringify(body),
  }, { method: 'POST', path, ms: limit('write'), session });

  const patch = (path, body = {}) => timedFetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: headers(authToken),
    body: JSON.stringify(body),
  }, { method: 'PATCH', path, ms: limit('write'), session });

  const del = (path, body) => timedFetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: headers(authToken),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { method: 'DELETE', path, ms: limit('write'), session });

  // Multipart upload via native FormData/Blob (Node 18+) — no runtime deps.
  // Content-Type is deliberately NOT set: fetch writes the multipart boundary.
  const upload = (path, {
    fileBuffer, fileName, contentType, fileField = 'file', fields = {},
  }) => {
    const form = new FormData();
    form.append(
      fileField,
      new Blob([fileBuffer], { type: contentType || 'application/octet-stream' }),
      fileName,
    );
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }
    return timedFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      body: form,
    }, { method: 'POST', path, ms: limit('upload'), session });
  };

  return {
    get, post, patch, del, upload, baseUrl,
  };
};

// Convenience: login doesn't need a token
export const login = (instanceUrl, email, password) => {
  const ms = capTimeoutMs('write');
  return timedFetch(`${instanceUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }, { method: 'POST', path: '/api/auth/login', ms, session: null });
};
