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

const handleResponse = async (res, session = null) => {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { message: text }; }
  if (!res.ok) {
    const msg = res.status === 401 && session && knownSessionFailure(body)
      ? sessionExpiredMessage(session)
      : body?.error || body?.message || body?.msg || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
};

export const createClient = ({ instance = null, token = undefined } = {}) => {
  const baseUrl = resolveInstanceUrl(instance);
  const resolved = resolveInstance(instance);
  const authToken = token === undefined ? getToken(instance) : token;
  const session = {
    instanceKey: resolved?.key || (typeof instance === 'string' && instance && !/^https?:\/\//i.test(instance) ? instance : 'default'),
    baseUrl,
  };

  const get = (path, params = {}) => {
    const url = new URL(`${baseUrl}${path}`);
    Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
    return fetch(url.toString(), { headers: headers(authToken) }).then((res) => handleResponse(res, session));
  };

  const post = (path, body = {}) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: headers(authToken),
    body: JSON.stringify(body),
  }).then((res) => handleResponse(res, session));

  const patch = (path, body = {}) => fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: headers(authToken),
    body: JSON.stringify(body),
  }).then((res) => handleResponse(res, session));

  const del = (path) => fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: headers(authToken),
  }).then((res) => handleResponse(res, session));

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
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      body: form,
    }).then((res) => handleResponse(res, session));
  };

  return {
    get, post, patch, del, upload, baseUrl,
  };
};

// Convenience: login doesn't need a token
export const login = async (instanceUrl, email, password) => {
  const res = await fetch(`${instanceUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return handleResponse(res);
};
