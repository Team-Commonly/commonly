// @ts-nocheck
// Mock axios with defaults and interceptors before importing
import axiosConfig from './axiosConfig';
import getApiBaseUrl from './apiBaseUrl';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    defaults: {
      baseURL: ''
    },
    interceptors: {
      request: {
        use: jest.fn()
      }
    }
  }
}));

describe('axiosConfig', () => {
  beforeEach(() => {
    // Mock the axios instance
    jest.clearAllMocks();
    localStorage.clear();
  });

  test('creates axios instance with default config', () => {
    expect(axiosConfig).toBeDefined();
    expect(axiosConfig.defaults.baseURL).toBe(getApiBaseUrl());
  });

  describe('request interceptor auth injection', () => {
    // The interceptor was registered at import time; pull the actual
    // function out of the mock so we can exercise it directly.
    const interceptor = axiosConfig.interceptors.request.use.mock.calls[0][0];

    test('injects the user JWT when no Authorization is set', () => {
      localStorage.setItem('token', 'user-jwt');
      const config = interceptor({ headers: {} });
      expect(config.headers.Authorization).toBe('Bearer user-jwt');
    });

    test('respects an explicit per-request Authorization (runtime tokens)', () => {
      // Regression: the BYO memory import authenticates with the agent's
      // cm_agent_* runtime token; overwriting it with the user JWT made the
      // kernel 401 (2026-07-03 live smoke).
      localStorage.setItem('token', 'user-jwt');
      const config = interceptor({ headers: { Authorization: 'Bearer cm_agent_runtime' } });
      expect(config.headers.Authorization).toBe('Bearer cm_agent_runtime');
    });

    test('leaves headers alone when no token is stored', () => {
      const config = interceptor({ headers: {} });
      expect(config.headers.Authorization).toBeUndefined();
    });
  });
});
