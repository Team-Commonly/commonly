import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import Register from './Register';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() }
}));
jest.mock('react-router-dom', () => ({ Link: ({ children }) => <a>{children}</a> }));

let container;
let root;

beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
});

test('successful register shows message', async () => {
  axios.post.mockResolvedValue({ data: { message: 'ok' } });
  await TestUtils.act(async () => { root.render(<Register />); });
  const form = container.querySelector('form');
  await TestUtils.act(async () => { TestUtils.Simulate.submit(form); });
  expect(axios.post).toHaveBeenCalled();
  expect(container.textContent).toContain('ok');
});

test('error register displays failure', async () => {
  axios.post.mockRejectedValue({ response: { data: { error: 'no' } } });
  await TestUtils.act(async () => { root.render(<Register />); });
  const form = container.querySelector('form');
  await TestUtils.act(async () => { TestUtils.Simulate.submit(form); });
  expect(container.textContent).toContain('no');
});
