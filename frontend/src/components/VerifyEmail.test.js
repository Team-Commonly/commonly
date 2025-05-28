import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import VerifyEmail from './VerifyEmail';
import axios from 'axios';
import { useSearchParams } from 'react-router-dom';

jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
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

test('verifies email and shows message', async () => {
  useSearchParams.mockReturnValue([new URLSearchParams('token=abc')]);
  axios.get.mockResolvedValue({ data: { message: 'ok' } });
  await TestUtils.act(async () => { root.render(<VerifyEmail />); });
  await TestUtils.act(async () => Promise.resolve());
  expect(axios.get).toHaveBeenCalledWith('/api/auth/verify-email?token=abc');
  expect(container.textContent).toContain('ok');
});
