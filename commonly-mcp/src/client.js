/**
 * HTTP client for the Commonly MCP server.
 *
 * Per ADR-010 §Auth contract:
 *   - One token per process. The runtime credential and `COMMONLY_API_URL` are
 *     read once at module load. Restart the host runtime to rotate.
 *   - User-Agent must NOT be the default Node `fetch` UA — Cloudflare blocks
 *     anonymous-looking clients (1010). The Python SDK hit this; same fix.
 *   - Errors surface verbatim (Invariant #6). We never wrap or downgrade
 *     backend status codes.
 *
 * Pure: input = method/path/body/query, output = parsed JSON body or thrown
 * `HttpError`. No global state beyond the env-derived config object.
 */

import { readFileSync } from 'fs';

const USER_AGENT = 'commonly-mcp/0.1.9';

export class HttpError extends Error {
  constructor(status, body, message) {
    super(message || `HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Read the runtime credential.
 *
 * THREE CHANNELS, resolved in this order by what the parent declares (TASK-078,
 * ruled 2026-09-19 — "take the token out of the environment" — extended the
 * same day to a file, so claude and codex can use it too):
 *
 *   1. `COMMONLY_TOKEN_FD` names an inherited pipe holding the credential. This
 *      is the channel the pi adapter uses: the token is never in this process's
 *      environment, so a same-user reader cannot get it from
 *      `/proc/<pid>/environ` or `ps eww <pid>` — which is exactly how the old
 *      channel leaked it.
 *   2. `COMMONLY_TOKEN_FILE` names a file holding the credential, written 0600
 *      for one spawn. This is the channel claude and codex use, because neither
 *      of them can be handed a pipe we opened: claude expands `${VAR}` from its
 *      own environment, and codex forwards declared variables from its own. A
 *      path is not a secret, so the token stays out of both of their
 *      environments even though it reaches the grandchild.
 *   3. `COMMONLY_AGENT_TOKEN` in the environment. Kept because the channel is a
 *      property of the PARENT, not of this package: an older daemon, another
 *      driver, or a hand-run server still passes it this way, and refusing the
 *      old channel would turn a security fix into an outage.
 *
 * A declared source is authoritative. A read that fails does NOT fall through
 * to the next one: silently using the weaker channel after being told to use
 * the stronger one is the class of bug this exists to remove.
 *
 * The fd is read to EOF and deliberately never closed — on macOS a `closeSync`
 * after a failed read aborts the process (`kqueue.c`), and the descriptor goes
 * away with the process anyway.
 */
export const readToken = (env = process.env, { readImpl = readFileSync } = {}) => {
  const declaredFd = env.COMMONLY_TOKEN_FD;
  const declaredFile = env.COMMONLY_TOKEN_FILE;
  const blank = (value) => value === undefined || String(value).trim() === '';

  if (!blank(declaredFd)) {
    const fd = Number.parseInt(String(declaredFd).trim(), 10);
    if (!Number.isInteger(fd) || fd < 0 || String(fd) !== String(declaredFd).trim()) {
      throw new Error(`COMMONLY_TOKEN_FD must be a file descriptor number, got '${declaredFd}'`);
    }
    let raw;
    try {
      raw = readImpl(fd, 'utf8');
    } catch (err) {
      throw new Error(`COMMONLY_TOKEN_FD=${fd} was declared but the credential could not be read from it: ${err.message}`);
    }
    const token = String(raw ?? '').trim();
    if (!token) {
      throw new Error(`COMMONLY_TOKEN_FD=${fd} carried an empty credential`);
    }
    return token;
  }

  if (!blank(declaredFile)) {
    const tokenPath = String(declaredFile).trim();
    let raw;
    try {
      raw = readImpl(tokenPath, 'utf8');
    } catch (err) {
      throw new Error(`COMMONLY_TOKEN_FILE=${tokenPath} was declared but the credential could not be read from it: ${err.message}`);
    }
    const token = String(raw ?? '').trim();
    if (!token) {
      throw new Error(`COMMONLY_TOKEN_FILE=${tokenPath} carried an empty credential`);
    }
    return token;
  }

  return env.COMMONLY_AGENT_TOKEN;
};

/**
 * Build the per-process config from env. Returned object is a frozen handle
 * passed to `request` so the env is read exactly once and tests can inject a
 * stub.
 *
 * Throws on missing required env vars — better than emitting silent 401s
 * later.
 */
export const loadConfig = (env = process.env, opts = {}) => {
  const baseUrl = env.COMMONLY_API_URL;
  const token = readToken(env, opts);
  if (!baseUrl) {
    throw new Error('COMMONLY_API_URL is required (e.g. https://api.commonly.me)');
  }
  if (!token) {
    throw new Error('No runtime token: COMMONLY_TOKEN_FD must name a pipe, COMMONLY_TOKEN_FILE must name a file, or COMMONLY_AGENT_TOKEN must be set (cm_agent_* runtime token)');
  }
  if (!token.startsWith('cm_agent_')) {
    throw new Error('The runtime token must be a cm_agent_* token, whichever channel delivered it');
  }
  return Object.freeze({
    baseUrl: baseUrl.replace(/\/$/, ''),
    token,
  });
};

/**
 * One-shot HTTP request. Returns the parsed JSON body on 2xx; throws
 * `HttpError` with the verbatim backend body otherwise.
 *
 * `query` is a flat object — all values stringified and URL-encoded.
 * `_fetchImpl` is a test seam (same convention as `cli/src/lib/adapters/*.js`).
 */
export const request = async (config, { method, path, query, body, _fetchImpl = fetch } = {}) => {
  let url = `${config.baseUrl}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers = {
    Authorization: `Bearer ${config.token}`,
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await _fetchImpl(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Read body once. Prefer JSON; fall back to text for non-JSON error pages
  // (Cloudflare 1010, gateway 502, etc.) so the agent sees the real signal.
  const raw = await res.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }

  if (!res.ok) {
    const message = (parsed && typeof parsed === 'object' && parsed.message)
      || (typeof parsed === 'string' ? parsed.slice(0, 500) : `HTTP ${res.status}`);
    throw new HttpError(res.status, parsed, message);
  }
  return parsed;
};

/**
 * Multipart upload — for attaching a local file to a pod. Node 18+ has global
 * FormData / Blob, so no runtime deps. `fileField` is the multipart field name
 * the backend's multer middleware expects. Same response handling as `request`.
 */
export const requestUpload = async (config, {
  path, fileBuffer, fileName, contentType, fileField = 'file', fields = {}, _fetchImpl = fetch,
} = {}) => {
  const url = `${config.baseUrl}${path}`;
  const form = new FormData();
  form.append(
    fileField,
    new Blob([fileBuffer], { type: contentType || 'application/octet-stream' }),
    fileName,
  );
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) form.append(k, String(v));
  }
  // Do NOT set Content-Type — fetch sets the multipart boundary itself.
  const res = await _fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    body: form,
  });
  const raw = await res.text();
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
  if (!res.ok) {
    const message = (parsed && typeof parsed === 'object' && parsed.message)
      || (typeof parsed === 'string' ? parsed.slice(0, 500) : `HTTP ${res.status}`);
    throw new HttpError(res.status, parsed, message);
  }
  return parsed;
};
