// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AdminUsers from '../components/V2AdminUsers';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), patch: jest.fn(), put: jest.fn(), delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = require('axios');

const admin = { _id: 'a1', username: 'admin', role: 'admin' };
const authValue = {
  currentUser: admin, user: admin, token: 't', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};
const user = {
  id: 'u1', username: 'mei', email: 'mei@example.com', role: 'user', verified: true, banned: false,
  createdAt: '2026-09-14T08:30:00Z',
};
const invitation = {
  id: 'i1', code: 'CODE-ONE', note: '', maxUses: 1, useCount: 0, isActive: true, expiresAt: null,
  lastUsedAt: null, createdAt: '2026-10-20T12:15:00Z', createdBy: null,
};

const renderPage = () => render(
  <MemoryRouter><AuthContext.Provider value={authValue}><V2AdminUsers /></AuthContext.Provider></MemoryRouter>,
);

beforeEach(() => {
  jest.clearAllMocks();
  axios.patch.mockResolvedValue({ data: {} });
  axios.delete.mockResolvedValue({ data: {} });
  axios.post.mockResolvedValue({ data: { invitation: { ...invitation, isActive: false } } });
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/admin/analytics/lifecycle')) return Promise.resolve({ data: { users: {} } });
    if (url.startsWith('/api/admin/users/waitlist')) return Promise.resolve({ data: { requests: [], total: 0, page: 1, limit: 100, totalPages: 1 } });
    if (url.startsWith('/api/admin/users/invitations')) return Promise.resolve({ data: { invitations: [invitation], total: 1, page: 1, limit: 100, totalPages: 1 } });
    return Promise.resolve({ data: { users: [user] } });
  });
});

const dialog = () => screen.getByRole('alertdialog');

test('a ban takes its reason from the dialog', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));
  expect(dialog()).toHaveTextContent('Ban mei? Optional reason:');
  fireEvent.change(within(dialog()).getByRole('textbox'), { target: { value: 'spam' } });
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Ban' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/admin/users/u1/ban', { banned: true, reason: 'spam' }, expect.anything(),
  ));
});

test('a ban with no reason still bans, and a cancelled one does not', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Ban' }));
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
  expect(axios.patch).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Ban' }));
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Ban' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/admin/users/u1/ban', { banned: true }, expect.anything(),
  ));
});

test('deleting a user and revoking a code each wait for the dialog', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
  expect(axios.delete).not.toHaveBeenCalled();
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(axios.delete).toHaveBeenCalled());
  expect(axios.delete.mock.calls[0][0]).toBe('/api/admin/users/u1');

  fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
  expect(dialog()).toHaveTextContent('Revoke invitation code CODE-ONE?');
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Revoke' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
    '/api/admin/users/invitations/i1/revoke', undefined, expect.anything(),
  ));
});
