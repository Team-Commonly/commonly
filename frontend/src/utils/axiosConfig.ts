import axios, { InternalAxiosRequestConfig } from 'axios';
import getApiBaseUrl from './apiBaseUrl';

// Set the base URL for all axios requests
axios.defaults.baseURL = getApiBaseUrl();

// Add a request interceptor to include the token in all requests.
// An explicit per-request Authorization header WINS over the ambient user
// JWT — the BYO memory import authenticates with the agent's cm_agent_*
// runtime token, and unconditionally overwriting it made the kernel see a
// user JWT and 401 (caught in the 2026-07-03 live smoke; mocks and a
// non-auth-enforcing stub both missed it).
axios.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = localStorage.getItem('token');
    if (token && !config.headers.Authorization) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }
    return config;
  },
  (error: unknown) => Promise.reject(error),
);

export default axios;
