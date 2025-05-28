import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import Register from './Register';
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
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
});

async function renderRegister() {
  await TestUtils.act(async () => {
    root.render(<Register />);
  });
}

test('successful registration shows message', async () => {
  axios.post.mockResolvedValue({ data: { message: 'ok' } });
  await renderRegister();
  await TestUtils.act(async () => {
    const input = container.querySelector('input');
    TestUtils.Simulate.change(input, { target: { value: 'u' } });
    TestUtils.Simulate.submit(container.querySelector('form'));
  });
  expect(axios.post).toHaveBeenCalled();
  expect(container.textContent).toContain('ok');
});

