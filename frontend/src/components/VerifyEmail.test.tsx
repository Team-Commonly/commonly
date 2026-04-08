// @ts-nocheck
import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import VerifyEmail from './VerifyEmail';
import { useSearchParams } from 'react-router-dom';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() }
}));
jest.mock('react-router-dom', () => ({ useSearchParams: jest.fn() }));

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

async function renderComponent(token) {
  useSearchParams.mockReturnValue([{ get: () => token }]);
  await TestUtils.act(async () => { root.render(<VerifyEmail />); });
  await TestUtils.act(async () => Promise.resolve());
}

test('verifies email and shows success message', async () => {
  axios.get.mockResolvedValueOnce({ data: { message: 'verified' } });
  await renderComponent('t1');
  expect(axios.get).toHaveBeenCalledWith('/api/auth/verify-email?token=t1');
  expect(container.textContent).toContain('verified');
  const loginLink = container.querySelector('a[href="/login"]');
  expect(loginLink).not.toBeNull();
});

test('shows error when verification fails', async () => {
  axios.get.mockRejectedValueOnce({ response: { data: { error: 'bad' } } });
  await renderComponent('t2');
  expect(container.textContent).toContain('bad');
  const loginLink = container.querySelector('a[href="/login"]');
  expect(loginLink).not.toBeNull();
});
