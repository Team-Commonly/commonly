import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
jest.mock('react-router-dom', () => ({ Link: ({ children }) => <a>{children}</a> }));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));

let Register;
const axios = require('axios').default;

let container;
let root;

beforeEach(() => {
  Register = require('./Register').default;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  axios.post.mockReset();
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
});

test('successful registration shows message', async () => {
  axios.post.mockResolvedValue({ data: { message: 'ok' } });
  await TestUtils.act(async () => {
    root.render(<Register />);
  });
  await TestUtils.act(async () => {
    TestUtils.Simulate.submit(container.querySelector('form'));
  });
  expect(container.textContent).toContain('ok');
});

test('failed registration shows error', async () => {
  axios.post.mockRejectedValue({ response: { data: { error: 'fail' } } });
  await TestUtils.act(async () => {
    root.render(<Register />);
  });
  await TestUtils.act(async () => {
    TestUtils.Simulate.submit(container.querySelector('form'));
  });
  expect(container.textContent).toContain('fail');
});
