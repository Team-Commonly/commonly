import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import VerifyEmail from './VerifyEmail';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() }
}));

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

test('displays success message', async () => {
  axios.get.mockResolvedValue({ data: { message: 'verified' } });
  await TestUtils.act(async () => {
    root.render(
      <MemoryRouter initialEntries={[ '/verify?token=abc' ]}>
        <VerifyEmail />
      </MemoryRouter>
    );
  });
  await TestUtils.act(async () => Promise.resolve());
  expect(axios.get).toHaveBeenCalledWith('/api/auth/verify-email?token=abc');
  expect(container.textContent).toContain('verified');
});

test('displays failure message', async () => {
  axios.get.mockRejectedValue({ response: { data: { error: 'bad' } } });
  await TestUtils.act(async () => {
    root.render(
      <MemoryRouter initialEntries={[ '/verify?token=x' ]}>
        <VerifyEmail />
      </MemoryRouter>
    );
  });
  await TestUtils.act(async () => Promise.resolve());
  expect(container.textContent).toContain('bad');
});
