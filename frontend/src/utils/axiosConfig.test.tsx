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
  });

  test('creates axios instance with default config', () => {
    expect(axiosConfig).toBeDefined();
    expect(axiosConfig.defaults.baseURL).toBe(getApiBaseUrl());
  });
});
