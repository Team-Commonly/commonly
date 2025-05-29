import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import UserProfile from './UserProfile';
import { useAppContext } from '../context/AppContext';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), put: jest.fn() }
}));
jest.mock('../context/AppContext', () => ({ useAppContext: jest.fn() }));

let container;
let root;

beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  localStorage.setItem('token', 't');
  useAppContext.mockReturnValue({ refreshAvatars: jest.fn() });
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
  localStorage.clear();
});

async function renderProfile() {
  axios.get
    .mockResolvedValueOnce({ data: { _id: 'u', username: 'user', email: 'e@example.com', createdAt: '2023-01-01' } })
    .mockResolvedValueOnce({ data: [] });
  await TestUtils.act(async () => {
    root.render(<UserProfile />);
  });
  await TestUtils.act(async () => Promise.resolve());
}

test('displays user info after fetch', async () => {
  await renderProfile();
  expect(axios.get).toHaveBeenCalledWith('/api/auth/profile', { headers: { Authorization: 'Bearer t' } });
  expect(container.textContent).toContain('user');
});

test('shows error when fetch fails', async () => {
  axios.get.mockRejectedValue(new Error('fail'));
  await TestUtils.act(async () => {
    root.render(<UserProfile />);
  });
  await TestUtils.act(async () => Promise.resolve());
  expect(container.textContent).toContain('Failed to fetch user data');
});
