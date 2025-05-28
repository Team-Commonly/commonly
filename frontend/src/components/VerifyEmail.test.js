import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('react-router-dom', () => ({ useSearchParams: jest.fn() }));

import VerifyEmail from './VerifyEmail';
import { useSearchParams } from 'react-router-dom';
const axios = require('axios').default;

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  useSearchParams.mockReturnValue([{ get: () => 'tok' }]);
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
  jest.clearAllMocks();
});

test('calls verify endpoint and shows message', async () => {
  axios.get.mockResolvedValue({ data: { message: 'done' } });
  await TestUtils.act(async () => { root.render(<VerifyEmail />); });
  expect(axios.get).toHaveBeenCalledWith('/api/auth/verify-email?token=tok');
  expect(container.textContent).toContain('done');
});

test('shows error on failure', async () => {
  axios.get.mockRejectedValue({ response: { data: { error: 'bad' } } });
  await TestUtils.act(async () => { root.render(<VerifyEmail />); });
  expect(container.textContent).toContain('bad');
});
