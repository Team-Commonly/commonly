jest.mock('axios', () => ({
  __esModule: true,
  default: {
    defaults: {},
    interceptors: { request: { handlers: [], use(fn) { this.handlers.push({ fulfilled: fn }); } } }
  }
}));
const axios = require('axios').default;

describe('axiosConfig', () => {
  beforeEach(() => {
    jest.resetModules();
    localStorage.clear();
  });

  test('sets baseURL from environment', () => {
    process.env.REACT_APP_API_URL = 'http://example.com';
    const instance = require('./axiosConfig').default;
    expect(instance.defaults.baseURL).toBe('http://example.com');
  });

  test('interceptor adds Authorization header', () => {
    const instance = require('./axiosConfig').default;
    localStorage.setItem('token', 'token123');
    const config = { headers: {} };
    const result = instance.interceptors.request.handlers[0].fulfilled(config);
    expect(result.headers.Authorization).toBe('Bearer token123');
  });
});
