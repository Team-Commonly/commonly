// @ts-nocheck
// Guards the BYO pod-picker default after the 2026-07-24 launch incident:
// new users auto-join Commonly HQ (publicRead), it sorts first by activity in
// /api/pods, and the old `installablePods[0]` default silently attached
// personal agents to the public room — a prompt-injection surface running with
// the owner's own tokens. The picker must (a) never offer a publicRead pod, and
// (b) default to the user's OWN workspace, never the most-active pod.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = jest.requireMock('axios').default;

const authValue = {
  currentUser: { _id: 'u1', username: 'sam' }, user: { _id: 'u1', username: 'sam' },
  token: 'jwt', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};
const renderPage = () => render(
  <AuthContext.Provider value={authValue}><MemoryRouter><V2AgentBYO /></MemoryRouter></AuthContext.Provider>,
);
afterEach(() => jest.clearAllMocks());

describe('V2AgentBYO pod picker safety (HQ funnel incident 2026-07-24)', () => {
  test('excludes publicRead pods and defaults to the user\'s own workspace', async () => {
    // Ordered like a new user's /api/pods: public HQ first by activity.
    axios.get.mockResolvedValueOnce({ data: [
      { _id: 'hq', name: 'Commonly HQ', type: 'chat', publicRead: true, createdBy: { _id: 'admin' } },
      { _id: 'ws', name: 'My Workspace', type: 'chat', createdBy: { _id: 'u1' } },
    ] });
    renderPage();
    await waitFor(() => expect(screen.getByText('My Workspace (chat)')).toBeInTheDocument());
    // Default target is the user's own workspace, NOT the most-active (HQ) pod.
    expect(screen.getByRole('combobox').value).toBe('ws');
    // The public room is not selectable here at all.
    expect(screen.queryByText('Commonly HQ (chat)')).not.toBeInTheDocument();
  });

  test('falls back to the first non-public pod when the user owns none', async () => {
    axios.get.mockResolvedValueOnce({ data: [
      { _id: 'hq', name: 'Commonly HQ', type: 'chat', publicRead: true, createdBy: { _id: 'admin' } },
      { _id: 'team', name: 'Some Team', type: 'chat', createdBy: { _id: 'other' } },
    ] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Some Team (chat)')).toBeInTheDocument());
    expect(screen.getByRole('combobox').value).toBe('team');
    expect(screen.queryByText('Commonly HQ (chat)')).not.toBeInTheDocument();
  });
});
