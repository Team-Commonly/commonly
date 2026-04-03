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

  const del = (path) => fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: headers(authToken),
  }).then(handleResponse);

  return { get, post, del, baseUrl };
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
