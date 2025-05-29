import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import Login from './Login';
import { BrowserRouter } from 'react-router-dom';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() }
}));

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  delete window.location;
  window.location = { href: 'start' };
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
  localStorage.clear();
});

async function renderAndSubmit() {
  await TestUtils.act(async () => {
    root.render(
      <BrowserRouter>
        <Login />
      </BrowserRouter>
    );
  });
  const [email, pass] = container.querySelectorAll('input');
  TestUtils.act(() => { TestUtils.Simulate.change(email, { target: { value: 'e' } }); });
  TestUtils.act(() => { TestUtils.Simulate.change(pass, { target: { value: 'p' } }); });
  const form = container.querySelector('form');
  await TestUtils.act(async () => { TestUtils.Simulate.submit(form); });
}

test('successful login stores token and redirects', async () => {
  axios.post.mockResolvedValueOnce({ data: { token: 't', verified: true } });
  await renderAndSubmit();
  expect(axios.post).toHaveBeenCalledWith('/api/auth/login', { email: 'e', password: 'p' });
  expect(localStorage.getItem('token')).toBe('t');
  expect(window.location.href).toBe('/feed');
});

test('shows error when email not verified', async () => {
  axios.post.mockResolvedValueOnce({ data: { verified: false } });
  await renderAndSubmit();
  expect(container.textContent).toContain('Please verify your email');
});
