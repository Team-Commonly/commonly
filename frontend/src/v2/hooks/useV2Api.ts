import { useCallback, useMemo } from 'react';
import axios, { AxiosRequestConfig } from 'axios';
import { useAuth } from '../../context/AuthContext';

export interface V2ApiClient {
  get: <T = unknown>(url: string, config?: AxiosRequestConfig) => Promise<T>;
  post: <T = unknown>(url: string, body?: unknown, config?: AxiosRequestConfig) => Promise<T>;
  patch: <T = unknown>(url: string, body?: unknown, config?: AxiosRequestConfig) => Promise<T>;
  // PUT, because `SET collapsed` is an idempotent set of one field and the
  // shipped route (#1109) is PUT /api/messages/:id/collapsed. Added rather
  // than routed through `patch`: the verb the server registered is the verb
  // the client should send.
  put: <T = unknown>(url: string, body?: unknown, config?: AxiosRequestConfig) => Promise<T>;
  del: <T = unknown>(url: string, config?: AxiosRequestConfig) => Promise<T>;
}

export const useV2Api = (): V2ApiClient => {
  const { token } = useAuth();

  const headers = useMemo(() => (
    token ? { Authorization: `Bearer ${token}` } : {}
  ), [token]);

  const get = useCallback(async <T,>(url: string, config: AxiosRequestConfig = {}) => {
    const res = await axios.get<T>(url, { ...config, headers: { ...headers, ...(config.headers || {}) } });
    return res.data;
  }, [headers]);

  const post = useCallback(async <T,>(url: string, body?: unknown, config: AxiosRequestConfig = {}) => {
    const res = await axios.post<T>(url, body, { ...config, headers: { ...headers, ...(config.headers || {}) } });
    return res.data;
  }, [headers]);

  const patch = useCallback(async <T,>(url: string, body?: unknown, config: AxiosRequestConfig = {}) => {
    const res = await axios.patch<T>(url, body, { ...config, headers: { ...headers, ...(config.headers || {}) } });
    return res.data;
  }, [headers]);

  const put = useCallback(async <T,>(url: string, body?: unknown, config: AxiosRequestConfig = {}) => {
    const res = await axios.put<T>(url, body, { ...config, headers: { ...headers, ...(config.headers || {}) } });
    return res.data;
  }, [headers]);

  const del = useCallback(async <T,>(url: string, config: AxiosRequestConfig = {}) => {
    const res = await axios.delete<T>(url, { ...config, headers: { ...headers, ...(config.headers || {}) } });
    return res.data;
  }, [headers]);

  return useMemo(() => ({
    get,
    post,
    patch,
    put,
    del,
  }), [get, post, patch, put, del]);
};
