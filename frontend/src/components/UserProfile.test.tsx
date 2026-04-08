// @ts-nocheck
import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import UserProfile from './UserProfile';
import { useAppContext } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), put: jest.fn() }
}));
jest.mock('../context/AppContext', () => ({ useAppContext: jest.fn() }));
jest.mock('../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('./admin/AdminUsers', () => () => null);
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ id: 'u' }),
}));

let container;
let root;

beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  localStorage.setItem('token', 't');
  useAppContext.mockReturnValue({ refreshAvatars: jest.fn() });
  useAuth.mockReturnValue({ currentUser: { _id: 'viewer', username: 'viewer' } });
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
  localStorage.clear();
});

async function renderProfile() {
  axios.get
    .mockResolvedValueOnce({ data: { _id: 'u', username: 'user', email: 'e@example.com', createdAt: '2023-01-01', profilePicture: 'default' } })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: { hasToken: false } })
    .mockResolvedValueOnce({ data: { recentPublicPosts: [], joinedPods: [] } });
  await TestUtils.act(async () => {
    root.render(
      <MemoryRouter>
        <UserProfile />
      </MemoryRouter>
    );
  });
  await TestUtils.act(async () => Promise.resolve());
}

test('displays user info after fetch', async () => {
  await renderProfile();
  expect(axios.get).toHaveBeenCalledWith('/api/users/u', { headers: { Authorization: 'Bearer t' } });
  expect(container.textContent).toContain('user');
});

test('shows error when fetch fails', async () => {
  axios.get.mockRejectedValue(new Error('fail'));
  await TestUtils.act(async () => {
    root.render(
      <MemoryRouter>
        <UserProfile />
      </MemoryRouter>
    );
  });
  await TestUtils.act(async () => Promise.resolve());
  expect(container.textContent).toContain('Failed to fetch user data');
});
