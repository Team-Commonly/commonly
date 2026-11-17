// @ts-nocheck
// F459 (d): a computer seat whose harness is signed out read "idle · now", as
// if it were fine. The roster names the signed-out harness to its installer;
// the card says so instead of idle.
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2YourTeamPage from '../components/V2YourTeamPage';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

const axios = jest.requireMock('axios').default;
const now = new Date().toISOString();

const seat = (overrides) => ({
  instanceId: 'default',
  podId: 'pod-1',
  podName: 'Launch',
  installedBy: 'me',
  lastActiveAt: now,
  runtime: { runtimeType: 'wrapper', adapter: 'claude', host: 'byo' },
  connection: { state: 'connected', lastSeenAt: now },
  ...overrides,
});

const renderWith = (agents) => {
  axios.get.mockImplementation(async (url) => {
    if (url === '/api/pods') return { data: [{ _id: 'pod-1', name: 'Launch' }] };
    if (url === '/api/registry/pods/pod-1/agents') return { data: { agents } };
    if (url.startsWith('/api/v1/tasks/')) return { data: { tasks: [] } };
    if (url === '/api/activity/decision-queue') return { data: { items: [] } };
    throw new Error(`unexpected GET ${url}`);
  });
  return render(
    <AuthContext.Provider value={{ user: { _id: 'me', role: 'user', entitlements: {} } }}>
      <MemoryRouter>
        <V2YourTeamPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
};

const cardOf = async (name) => (await screen.findByText(name)).closest('article');

afterEach(() => { jest.clearAllMocks(); });

describe('a team card whose computer reports its harness signed out', () => {
  it('says the harness is not signed in, not idle', async () => {
    renderWith([
      seat({ name: 'nova', displayName: 'Nova', userId: 'u-nova', harnessSignedOut: 'claude' }),
      seat({ name: 'kit', displayName: 'Kit', userId: 'u-kit', runtime: { runtimeType: 'wrapper', adapter: 'codex', host: 'byo' }, harnessSignedOut: 'codex' }),
    ]);
    const nova = await cardOf('Nova');
    expect(within(nova).getByText('Claude Code is signed out')).toBeInTheDocument();
    expect(within(nova).queryByText(/^idle/)).toBeNull();
    expect(within(await cardOf('Kit')).getByText('Codex is signed out')).toBeInTheDocument();
  });

  it('keeps idle for a signed-in seat', async () => {
    renderWith([seat({ name: 'nova', displayName: 'Nova', userId: 'u-nova' })]);
    const nova = await cardOf('Nova');
    expect(within(nova).getByText(/^idle/)).toBeInTheDocument();
    expect(within(nova).queryByText(/signed out/)).toBeNull();
  });
});
