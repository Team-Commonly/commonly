/* eslint-disable react/display-name */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2PodInspector from '../components/V2PodInspector';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({ get: jest.fn().mockResolvedValue({}), post: jest.fn(), patch: jest.fn(), del: jest.fn() }),
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'human-1', username: 'sam' } }),
}));
jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));
jest.mock('../components/V2Avatar', () => () => <span data-testid="avatar" />);

const detail = {
  pod: { _id: 'room-1', name: 'Scout', type: 'agent-room', createdBy: { _id: 'human-1' } },
  members: [
    { _id: 'human-1', username: 'sam', isBot: false },
    { _id: 'agent-1', username: 'scout', isBot: true },
  ],
  agents: [], messages: [], loading: false, error: null, sendError: null,
  hasMore: false, loadingOlder: false, loadOlder: jest.fn(), refresh: jest.fn(), sendMessage: jest.fn(),
};

describe('V2PodInspector agent room', () => {
  it('shows both 1:1 participants without exposing pod membership controls', () => {
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

    expect(screen.getByTestId('inspector-room-participants')).toHaveTextContent('sam');
    expect(screen.getByTestId('inspector-room-participants')).toHaveTextContent('scout');
    expect(screen.queryByRole('tab', { name: 'inspector.tabs.members' })).toBeNull();
  });
});
