// Mock axios with defaults and interceptors before importing
import axiosConfig from './axiosConfig';

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
    expect(axiosConfig.defaults.baseURL).toBe(process.env.REACT_APP_API_URL || 'http://localhost:5000');
  });
});
