/**
 * HTTP client for the Commonly MCP server.
 *
 * Per ADR-010 §Auth contract:
 *   - One token per process. `COMMONLY_AGENT_TOKEN` and `COMMONLY_API_URL` are
 *     read once at module load. Restart the host runtime to rotate.
 *   - User-Agent must NOT be the default Node `fetch` UA — Cloudflare blocks
 *     anonymous-looking clients (1010). The Python SDK hit this; same fix.
 *   - Errors surface verbatim (Invariant #6). We never wrap or downgrade
 *     backend status codes.
 *
 * Pure: input = method/path/body/query, output = parsed JSON body or thrown
 * `HttpError`. No global state beyond the env-derived config object.
 */

const USER_AGENT = 'commonly-mcp/0.1.0';

export class HttpError extends Error {
  constructor(status, body, message) {
    super(message || `HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Build the per-process config from env. Returned object is a frozen handle
 * passed to `request` so the env is read exactly once and tests can inject a
 * stub.
 *
 * Throws on missing required env vars — better than emitting silent 401s
 * later.
 */
export const loadConfig = (env = process.env) => {
  const baseUrl = env.COMMONLY_API_URL;
  const token = env.COMMONLY_AGENT_TOKEN;
  if (!baseUrl) {
    throw new Error('COMMONLY_API_URL is required (e.g. https://api-dev.commonly.me)');
  }
  if (!token) {
    throw new Error('COMMONLY_AGENT_TOKEN is required (cm_agent_* runtime token)');
  }
  if (!token.startsWith('cm_agent_')) {
    throw new Error('COMMONLY_AGENT_TOKEN must be a cm_agent_* runtime token');
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
