import { useCallback, useMemo } from 'react';
import axios, { AxiosRequestConfig } from 'axios';
import { useAuth } from '../../context/AuthContext';

export interface V2ApiClient {
  get: <T = unknown>(url: string, config?: AxiosRequestConfig) => Promise<T>;
  post: <T = unknown>(url: string, body?: unknown, config?: AxiosRequestConfig) => Promise<T>;
  patch: <T = unknown>(url: string, body?: unknown, config?: AxiosRequestConfig) => Promise<T>;
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

  const del = useCallback(async <T,>(url: string, config: AxiosRequestConfig = {}) => {
    const res = await axios.delete<T>(url, { ...config, headers: { ...headers, ...(config.headers || {}) } });
    return res.data;
  }, [headers]);

  return useMemo(() => ({
    get,
    post,
    patch,
    del,
  }), [get, post, patch, del]);
};
