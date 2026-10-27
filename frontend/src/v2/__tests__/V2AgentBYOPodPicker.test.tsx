// @ts-nocheck
// Keep setup request assertions independent of funnel telemetry.
jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
// Guards the BYO pod-picker default after the 2026-07-24 launch incident:
// new users auto-join Commonly HQ (publicRead), it sorts first by activity in
// /api/pods, and the old `installablePods[0]` default silently attached
// personal agents to the public room — a prompt-injection surface running with
// the owner's own tokens. The picker must (a) never offer a publicRead pod, and
// (b) prefer the pod this person opened over their signup workspace, never
// the most-active pod.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';
import { POD_VISITS_KEY } from '../lib/podRecency';
// This suite owns the BYO request sequence, not the attention queries the chrome
// makes. Each one would otherwise consume a queued pod-list response.
jest.mock('../components/V2NavRail', () => () => null);
jest.mock('../hooks/useV2PodAttention', () => ({
  ...jest.requireActual('../hooks/useV2PodAttention'),
  useV2PodAttention: () => ({ items: [], count: null, countByPod: {}, refresh: async () => {} }),
}));

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
afterEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

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

  test('defaults to the last opened team pod instead of the user\'s workspace', async () => {
    localStorage.setItem(POD_VISITS_KEY, JSON.stringify({ ws: 10, team: 20, hq: 30 }));
    axios.get.mockResolvedValueOnce({ data: [
      { _id: 'hq', name: 'Commonly HQ', type: 'chat', publicRead: true },
      { _id: 'ws', name: 'My Workspace', type: 'chat', createdBy: { _id: 'u1' } },
      { _id: 'team', name: 'Team Project', type: 'team', createdBy: { _id: 'u2' } },
    ] });
    renderPage();
    await waitFor(() => expect(screen.getByRole('combobox').value).toBe('team'));
    expect(screen.queryByText('Commonly HQ (chat)')).not.toBeInTheDocument();
  });

  test('a valid deep link wins over visits, and other My Workspace pods name their owner', async () => {
    localStorage.setItem(POD_VISITS_KEY, JSON.stringify({ aaa: 30 }));
    window.history.replaceState({}, '', '/v2/agents/byo?pod=bbb');
    axios.get.mockResolvedValueOnce({ data: [
      { _id: 'aaa', name: 'My Workspace', type: 'chat', createdBy: { _id: 'u1', username: 'sam' } },
      { _id: 'bbb', name: 'My Workspace', type: 'chat', createdBy: { _id: 'u2', username: 'alex' } },
    ] });
    renderPage();
    await waitFor(() => expect(screen.getByRole('combobox').value).toBe('bbb'));
    expect(screen.getByText('My Workspace (chat)')).toBeInTheDocument();
    expect(screen.getByText('My Workspace (alex) (chat)')).toBeInTheDocument();
  });
});
