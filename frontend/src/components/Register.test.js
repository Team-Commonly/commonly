import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import Register from './Register';
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
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
});

async function renderAndSubmit() {
  await TestUtils.act(async () => {
    root.render(
      <BrowserRouter>
        <Register />
      </BrowserRouter>
    );
  });
  const [user, email, pass] = container.querySelectorAll('input');
  TestUtils.act(() => { TestUtils.Simulate.change(user, { target: { value: 'u' } }); });
  TestUtils.act(() => { TestUtils.Simulate.change(email, { target: { value: 'e' } }); });
  TestUtils.act(() => { TestUtils.Simulate.change(pass, { target: { value: 'p' } }); });
  const form = container.querySelector('form');
  await TestUtils.act(async () => { TestUtils.Simulate.submit(form); });
}

test('shows success message on registration', async () => {
  axios.post.mockResolvedValueOnce({ data: { message: 'ok' } });
  await renderAndSubmit();
  expect(axios.post).toHaveBeenCalledWith('/api/auth/register', {
    username: 'u',
    email: 'e',
    password: 'p'
  });
  expect(container.textContent).toContain('ok');
});

test('shows error when registration fails', async () => {
  axios.post.mockRejectedValueOnce({ response: { data: { error: 'fail' } } });
  await renderAndSubmit();
  expect(container.textContent).toContain('fail');
});
