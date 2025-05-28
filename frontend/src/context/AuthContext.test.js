import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { AuthProvider, useAuth } from './AuthContext';
const axios = require('axios').default;
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn() }
}));

const TestComponent = () => {
  const auth = useAuth();
  useEffect(() => {
    global.testAuth = auth;
  }, [auth]);
  return null;
};

let container;
let root;

beforeEach(() => {
  jest.resetAllMocks();
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  act(() => {
    root.render(
      <AuthProvider>
        <TestComponent />
      </AuthProvider>
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  container = null;
  delete global.testAuth;
});

test('register stores token and user', async () => {
  axios.post.mockResolvedValue({ data: { token: 'abc', user: { name: 'Bob' } } });
  await act(async () => {
    await global.testAuth.register({});
  });
  expect(localStorage.getItem('token')).toBe('abc');
  expect(global.testAuth.currentUser).toEqual({ name: 'Bob' });
  expect(axios.post).toHaveBeenCalledWith('/api/auth/register', {});
});

test('logout clears token and user', () => {
  localStorage.setItem('token', 't');
  act(() => {
    global.testAuth.logout();
  });
  expect(localStorage.getItem('token')).toBeNull();
  expect(global.testAuth.currentUser).toBeNull();
});
