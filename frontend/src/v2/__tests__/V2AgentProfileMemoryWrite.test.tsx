import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import V2AgentProfile from '../agents/V2AgentProfile';
import i18n, { i18nReady } from '../../i18n';

jest.mock('axios', () => {
  const profileClient = { get: jest.fn(), post: jest.fn() };
  return {
    __esModule: true,
    default: { create: jest.fn(() => profileClient) },
    __profileClient: profileClient,
  };
});
jest.mock('../../utils/avatarUtils', () => ({
  presetCharacterOptions: jest.fn(() => []),
}));
jest.mock('../components/V2Avatar', () => ({
  __esModule: true,
  default: () => null,
}));

const profileClient = (jest.requireMock('axios') as { __profileClient: { get: jest.Mock; post: jest.Mock } }).__profileClient;

const renderProfile = () => render(
  <MemoryRouter initialEntries={['/v2/agents/claude-code/observer']}>
    <Routes>
      <Route path="/v2/agents/:agentName/:instanceId" element={<V2AgentProfile />} />
    </Routes>
  </MemoryRouter>,
);

// The profile route is unauthenticated, so it reports the KIND of the latest
// agent-authored write and never the section name. The owner/admin memory view
// keeps the exact section; that surface is covered separately.
const profilePayload = (lastAgentWrite: unknown) => ({
  data: {
    agent: {
      agentName: 'claude-code',
      instanceId: 'observer',
      displayName: 'Observer',
      profilePicture: 'default',
      runtime: null,
      officialAgent: false,
      capabilities: [],
    },
    skills: [],
    pods: { count: 0, public: [] },
    memory: { has: true, entryCount: 2, lastAgentWrite },
    activity: [],
  },
});
const twoHoursAgo = () => new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString();

describe('V2AgentProfile memory-write visibility', () => {
  beforeAll(async () => {
    await i18nReady;
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    window.localStorage.clear();
    jest.clearAllMocks();
    profileClient.get.mockImplementation((url: string) => {
      if (url.startsWith('/api/agent-memory/')) return Promise.reject(new Error('not owner'));
      return Promise.resolve(profilePayload({ kind: 'durable', updatedAt: twoHoursAgo() }));
    });
    profileClient.post.mockResolvedValue({ data: { room: { _id: 'room-scout' } } });
  });

  it('reports the kind of the latest agent-authored write', async () => {
    renderProfile();

    expect(await screen.findByText(/Last saved to durable memory \d+h ago\./)).toBeInTheDocument();
  });

  it('reports a housekeeping write without naming the section', async () => {
    profileClient.get.mockImplementation((url: string) => {
      if (url.startsWith('/api/agent-memory/')) return Promise.reject(new Error('not owner'));
      return Promise.resolve(profilePayload({ kind: 'bookkeeping', updatedAt: twoHoursAgo() }));
    });
    renderProfile();

    expect(await screen.findByText(/Last saved to internal bookkeeping \d+h ago\./)).toBeInTheDocument();
    // No section name reaches this page for any kind.
    expect(screen.queryByText(/Runtime metadata|Deduplication state|Long-term memory/)).toBeNull();
  });

  it('shows an owner the revoked connection and a single Reconnect action', async () => {
    window.localStorage.setItem('token', 'owner-token');
    profileClient.get.mockImplementation((url: string) => {
      if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
        viewerRole: 'owner', totalEntries: 0, sections: [], pods: [{ id: 'pod-1', name: 'Workspace' }],
      } });
      if (url.startsWith('/api/registry/agents/claude-code/manage-settings')) return Promise.resolve({ data: {
        writablePodId: 'pod-1',
      } });
      if (url === '/api/registry/pods/pod-1/agents') return Promise.resolve({ data: { agents: [{
        name: 'claude-code', instanceId: 'observer', runtime: { runtimeType: 'webhook' },
        connection: { state: 'revoked', lastSeenAt: null },
      }] } });
      return Promise.resolve(profilePayload(null));
    });
    renderProfile();
    expect(await screen.findByTestId('agent-profile-connection'))
      .toHaveTextContent('Disconnected: key revoked');
    expect(screen.getByRole('link', { name: 'Reconnect' }))
      .toHaveAttribute('href', '/v2/agents/byo?pod=pod-1&name=claude-code&instanceId=observer&reconnect=1');
    expect(screen.queryByRole('button', { name: 'Talk to Observer' })).toBeNull();
  });

  it('uses the installer-owned pod when another pod appears first in the memory index', async () => {
    window.localStorage.setItem('token', 'owner-token');
    profileClient.get.mockImplementation((url: string) => {
      if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
        viewerRole: 'owner', totalEntries: 0, sections: [],
        pods: [{ id: 'other-pod', name: 'Other team' }, { id: 'own-pod', name: 'Workspace' }],
      } });
      if (url.startsWith('/api/registry/agents/claude-code/manage-settings')) return Promise.resolve({ data: {
        installations: [{ podId: 'other-pod', podName: 'Other team' }], writablePodId: 'own-pod',
      } });
      if (url === '/api/registry/pods/own-pod/agents') return Promise.resolve({ data: { agents: [{
        name: 'claude-code', instanceId: 'observer', runtime: { runtimeType: 'wrapper' },
        connection: { state: 'stale', lastSeenAt: new Date(Date.now() - 7 * 60000).toISOString() },
      }] } });
      return Promise.resolve(profilePayload(null));
    });
    renderProfile();
    expect(await screen.findByRole('link', { name: 'Reconnect' }))
      .toHaveAttribute('href', '/v2/agents/byo?pod=own-pod&name=claude-code&instanceId=observer&reconnect=1&mode=machine');
    expect(profileClient.get.mock.calls.some(([url]) => url === '/api/registry/pods/other-pod/agents')).toBe(false);
  });

  it('does not offer Reconnect to a signed-in pod member without management access', async () => {
    window.localStorage.setItem('token', 'member-token');
    renderProfile();
    expect(await screen.findByRole('heading', { name: 'Observer' })).toBeInTheDocument();
    await waitFor(() => expect(profileClient.get).toHaveBeenCalledWith(
      '/api/agent-memory/claude-code/observer',
      { headers: { Authorization: 'Bearer member-token' } },
    ));
    expect(profileClient.get.mock.calls.some(([url]) => url.startsWith('/api/registry/pods/'))).toBe(false);
    expect(screen.queryByRole('link', { name: 'Reconnect' })).toBeNull();
  });

  it('opens the same 1:1 room endpoint for a signed-in visitor', async () => {
    window.localStorage.setItem('token', 'viewer-token');
    renderProfile();

    fireEvent.click(await screen.findByRole('button', { name: 'Talk to Observer' }));

    await waitFor(() => expect(profileClient.post).toHaveBeenCalledWith(
      '/api/agents/runtime/room',
      { agentName: 'claude-code', instanceId: 'observer' },
      { headers: { Authorization: 'Bearer viewer-token' } },
    ));
  });

  it('keeps room-endpoint diagnostics off the profile page', async () => {
    window.localStorage.setItem('token', 'viewer-token');
    profileClient.post.mockRejectedValue({
      response: { data: { message: 'Multiple installations found. Specify instanceId.' } },
    });
    renderProfile();

    fireEvent.click(await screen.findByRole('button', { name: 'Talk to Observer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The 1:1 with this agent could not be opened.',
    );
    expect(screen.queryByText('Multiple installations found. Specify instanceId.')).not.toBeInTheDocument();
  });
});
