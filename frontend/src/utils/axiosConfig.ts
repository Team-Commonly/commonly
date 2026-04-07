import axios, { InternalAxiosRequestConfig } from 'axios';
import getApiBaseUrl from './apiBaseUrl';

// Set the base URL for all axios requests
axios.defaults.baseURL = getApiBaseUrl();

// Add a request interceptor to include the token in all requests
axios.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }
    return config;
  },
  (error: unknown) => Promise.reject(error),
);

export default axios;
