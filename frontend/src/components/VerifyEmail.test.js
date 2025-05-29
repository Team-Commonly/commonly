import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
jest.mock('react-router-dom', () => ({ useSearchParams: jest.fn() }));
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));

let VerifyEmail;
const { useSearchParams } = require('react-router-dom');
const axios = require('axios').default;

let container;
let root;

beforeEach(() => {
  VerifyEmail = require('./VerifyEmail').default;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
});

test('fetches verification status and displays message', async () => {
  useSearchParams.mockReturnValue([{ get: () => 'tok' }]);
  axios.get.mockResolvedValue({ data: { message: 'done' } });
  await TestUtils.act(async () => { root.render(<VerifyEmail />); });
  await TestUtils.act(async () => Promise.resolve());
  expect(axios.get).toHaveBeenCalledWith('/api/auth/verify-email?token=tok');
  expect(container.textContent).toContain('done');
});
