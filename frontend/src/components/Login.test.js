import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import Login from './Login';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() }
}));

jest.mock('react-router-dom', () => ({ Link: ({children}) => <a>{children}</a> }));

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  Object.defineProperty(window, 'location', { writable: true, value: { href: '' } });
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
  localStorage.clear();
});

async function renderLogin() {
  await TestUtils.act(async () => {
    root.render(<Login />);
  });
}

test('successful login redirects to feed', async () => {
  axios.post.mockResolvedValue({ data: { token: 'tok', verified: true } });
  await renderLogin();
  await TestUtils.act(async () => {
    const email = container.querySelector('input[type="email"]');
    const pass = container.querySelector('input[type="password"]');
    email.value = 'a@b.com';
    pass.value = 'p';
    TestUtils.Simulate.change(email, { target: { value: 'a@b.com' } });
    TestUtils.Simulate.change(pass, { target: { value: 'p' } });
    TestUtils.Simulate.submit(container.querySelector('form'));
  });
  expect(axios.post).toHaveBeenCalledWith('/api/auth/login', { email: 'a@b.com', password: 'p' });
  expect(localStorage.getItem('token')).toBe('tok');
  expect(window.location.href).toBe('/feed');
});

test('shows error when login fails', async () => {
  axios.post.mockRejectedValue({ response: { data: { error: 'bad' } } });
  await renderLogin();
  await TestUtils.act(async () => {
    TestUtils.Simulate.submit(container.querySelector('form'));
  });
  expect(container.textContent).toContain('bad');
});
