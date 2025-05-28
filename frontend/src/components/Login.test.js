import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() }
}));
jest.mock('react-router-dom', () => ({ Link: ({children}) => <a>{children}</a> }));

import Login from './Login';
const axios = require('axios').default;

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  delete window.location;
  window.location = { href: '' };
  localStorage.clear();
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
  jest.clearAllMocks();
  localStorage.clear();
});

test('submits credentials and redirects when verified', async () => {
  axios.post.mockResolvedValue({ data: { token: 'tok', verified: true } });
  await TestUtils.act(async () => {
    root.render(<Login />);
  });
  const [email, pass] = container.querySelectorAll('input');
  await TestUtils.act(async () => {
    TestUtils.Simulate.change(email, { target: { value: 'a@b.com' } });
    TestUtils.Simulate.change(pass, { target: { value: 'pw' } });
  });
  await TestUtils.act(async () => {
    TestUtils.Simulate.submit(container.querySelector('form'));
  });
  expect(axios.post).toHaveBeenCalledWith('/api/auth/login', { email: 'a@b.com', password: 'pw' });
  expect(localStorage.getItem('token')).toBe('tok');
  expect(window.location.href).toBe('/feed');
});

test('shows error when not verified', async () => {
  axios.post.mockResolvedValue({ data: { verified: false } });
  await TestUtils.act(async () => {
    root.render(<Login />);
  });
  await TestUtils.act(async () => {
    TestUtils.Simulate.submit(container.querySelector('form'));
  });
  expect(container.textContent).toContain('Please verify your email');
});
