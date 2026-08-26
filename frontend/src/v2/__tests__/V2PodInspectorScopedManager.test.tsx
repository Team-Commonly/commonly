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
  agents: [],
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

describe('V2PodInspector scoped manager action', () => {
  beforeEach(() => jest.clearAllMocks());

  test('opens the agent manager with the current pod preselected', () => {
    render(
      <MemoryRouter>
        <V2PodInspector
          detail={detail as any}
          view={{ kind: 'overview' }}
          onOpenMember={jest.fn()}
          onOpenArtifact={jest.fn()}
          onBack={jest.fn()}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('tab', { name: /inspector\.tabs\.members/ }));
    fireEvent.click(screen.getByTitle('inspector.members.manageTitle'));

    expect(mockNavigate).toHaveBeenCalledWith('/v2/agents/manage?podId=pod-1');
  });
});
