// The axios stand-in the Connectors suites share. It imports nothing, so a suite's
// `jest.mock('axios', () => require('../__testkit__/axiosMock').axiosFactory())`
// cannot loop back through the modules that import axios.
export const axiosFactory = () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
};
