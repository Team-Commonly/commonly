/* eslint-disable react/display-name */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2PodInspector from '../components/V2PodInspector';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({
    get: jest.fn().mockResolvedValue({}),
    post: jest.fn(), patch: jest.fn(), del: jest.fn(),
  }),
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'human-1', username: 'sam' } }),
}));

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

jest.mock('../components/V2Avatar', () => () => <span data-testid="avatar" />);

const detail = {
  pod: { _id: 'pod-1', name: 'Workspace', type: 'team' },
  members: [],
  agents: [{
    agentName: 'scout/ops',
    instanceId: 'blue sky',
    displayName: 'Scout',
    runtime: { runtimeType: 'webhook' },
  }],
  messages: [],
  loading: false,
  error: null,
  sendError: null,
  hasMore: false,
  loadingOlder: false,
  loadOlder: jest.fn(),
  refresh: jest.fn(),
  sendMessage: jest.fn(),
};

const detailWithoutAgentName = {
  ...detail,
  agents: [{ ...detail.agents[0], agentName: '' }],
};

describe('V2PodInspector member profile action', () => {
  beforeEach(() => jest.clearAllMocks());

  test('opens the selected agent profile instead of the fleet manager', () => {
    render(
      <MemoryRouter>
        <V2PodInspector
          detail={detail as any}
          view={{ kind: 'member', agentKey: 'scout/ops:blue sky' }}
          onOpenMember={jest.fn()}
          onOpenArtifact={jest.fn()}
          onBack={jest.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('yourTeam.card.profile')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'yourTeam.card.viewProfileAria' }));

    expect(mockNavigate).toHaveBeenCalledWith('/v2/agent/scout%2Fops/blue%20sky');
  });

  test('does not construct a route when a malformed registry row lacks an agent name', () => {
    render(
      <MemoryRouter>
        <V2PodInspector
          detail={detailWithoutAgentName as any}
          view={{ kind: 'member', agentKey: ':blue sky' }}
          onOpenMember={jest.fn()}
          onOpenArtifact={jest.fn()}
          onBack={jest.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'yourTeam.card.viewProfileAria' })).toBeDisabled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
