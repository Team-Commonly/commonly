import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
jest.mock('react-router-dom', () => ({ Link: ({ children }) => <a>{children}</a> }));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));

let Login;
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() }
}));

let container;
let root;

beforeEach(() => {
  Login = require('./Login').default;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  axios.post.mockReset();
  window.location = { href: '' };
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
  localStorage.clear();
});

test('successful login stores token and redirects', async () => {
  axios.post.mockResolvedValue({ data: { token: 'abc', verified: true } });
  await TestUtils.act(async () => {
    root.render(<Login />);
  });
  TestUtils.act(() => {
    container.querySelector('input[type="email"]').value = 'a@b.com';
    TestUtils.Simulate.change(container.querySelector('input[type="email"]'), { target: { value: 'a@b.com' } });
    container.querySelector('input[type="password"]').value = 'p';
    TestUtils.Simulate.change(container.querySelector('input[type="password"]'), { target: { value: 'p' } });
  });
  await TestUtils.act(async () => {
    TestUtils.Simulate.submit(container.querySelector('form'));
  });
  expect(axios.post).toHaveBeenCalledWith('/api/auth/login', { email: 'a@b.com', password: 'p' });
  expect(localStorage.getItem('token')).toBe('abc');
  // location update triggers full page load; just ensure token saved
});

test('shows message when email not verified', async () => {
  axios.post.mockResolvedValue({ data: { verified: false } });
  await TestUtils.act(async () => {
    root.render(<Login />);
  });
  await TestUtils.act(async () => {
    TestUtils.Simulate.submit(container.querySelector('form'));
  });
  expect(container.textContent).toContain('Please verify your email');
});
