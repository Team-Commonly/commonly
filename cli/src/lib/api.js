/**
 * CAP HTTP client — thin wrapper over fetch.
 *
 * Every method reads the active instance URL and token from config
 * unless overridden. This is the only place that makes HTTP calls.
 */

import { resolveInstanceUrl, getToken } from './config.js';

const headers = (token, extra = {}) => ({
  'Content-Type': 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...extra,
});

const handleResponse = async (res) => {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { message: text }; }
  if (!res.ok) {
    const msg = body?.error || body?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
};

export const createClient = ({ instance = null, token = null } = {}) => {
  const baseUrl = resolveInstanceUrl(instance);
  const authToken = token || getToken(instance);

  const get = (path, params = {}) => {
    const url = new URL(`${baseUrl}${path}`);
    Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
    return fetch(url.toString(), { headers: headers(authToken) }).then(handleResponse);
  };

  const post = (path, body = {}) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: headers(authToken),
    body: JSON.stringify(body),
  }).then(handleResponse);

  const patch = (path, body = {}) => fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: headers(authToken),
    body: JSON.stringify(body),
  }).then(handleResponse);

  const del = (path) => fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: headers(authToken),
  }).then(handleResponse);

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
    }).then(handleResponse);
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
