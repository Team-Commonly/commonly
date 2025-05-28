import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() }
}));
jest.mock('react-router-dom', () => ({ Link: ({children}) => <a>{children}</a> }));

import Register from './Register';
const axios = require('axios').default;

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
  jest.clearAllMocks();
});

test('shows success message on register', async () => {
  axios.post.mockResolvedValue({ data: { message: 'ok' } });
  await TestUtils.act(async () => { root.render(<Register />); });
  const form = container.querySelector('form');
  await TestUtils.act(async () => { TestUtils.Simulate.submit(form); });
  expect(axios.post).toHaveBeenCalled();
  expect(container.textContent).toContain('ok');
});

test('shows error on failure', async () => {
  axios.post.mockRejectedValue({ response: { data: { error: 'bad' } } });
  await TestUtils.act(async () => { root.render(<Register />); });
  const form = container.querySelector('form');
  await TestUtils.act(async () => { TestUtils.Simulate.submit(form); });
  expect(container.textContent).toContain('bad');
});
