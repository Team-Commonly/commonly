import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import Login from './Login';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() }
}));
// Simple Link mock
jest.mock('react-router-dom', () => ({ Link: ({ children }) => <a>{children}</a> }));

let container;
let root;
let oldLocation;

beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  oldLocation = window.location;
  delete window.location;
  window.location = { href: '' };
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
  window.location = oldLocation;
  localStorage.clear();
});

test('successful login stores token and redirects', async () => {
  axios.post.mockResolvedValue({ data: { token: 'abc', verified: true } });
  await TestUtils.act(async () => {
    root.render(<Login />);
  });
  const email = container.querySelector('input[type="email"]');
  const password = container.querySelector('input[type="password"]');
  const form = container.querySelector('form');
  TestUtils.act(() => { TestUtils.Simulate.change(email, { target: { value: 'a@b.com' } }); });
  TestUtils.act(() => { TestUtils.Simulate.change(password, { target: { value: 'pw' } }); });
  await TestUtils.act(async () => {
    TestUtils.Simulate.submit(form);
  });
  expect(axios.post).toHaveBeenCalledWith('/api/auth/login', { email: 'a@b.com', password: 'pw' });
  expect(localStorage.getItem('token')).toBe('abc');
  expect(window.location.href).toBe('/feed');
});

test('failed login shows error', async () => {
  axios.post.mockRejectedValue({ response: { data: { error: 'bad' } } });
  await TestUtils.act(async () => { root.render(<Login />); });
  const form = container.querySelector('form');
  await TestUtils.act(async () => { TestUtils.Simulate.submit(form); });
  expect(container.textContent).toContain('bad');
});
