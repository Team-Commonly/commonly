// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import V2PodsSidebar from '../components/V2PodsSidebar';

const COMMUNITY_POD_ID = 'community-pod';
const mockJoinPod = jest.fn();
const mockSeedFromExisting = jest.fn();

jest.mock('../hooks/useV2Pods', () => ({
  useV2Pods: () => ({
    pods: [],
    loading: false,
    error: null,
    createPod: jest.fn(),
    patchLastMessage: jest.fn(),
  }),
}));

jest.mock('../hooks/useV2Pinned', () => ({
  useV2Pinned: () => ({
    pinned: new Set(),
    toggle: jest.fn(),
    isPinned: () => false,
  }),
}));

jest.mock('../hooks/useV2Unread', () => ({
  useV2Unread: () => ({
    isUnread: () => false,
    bumpLatest: jest.fn(),
    seedFromExisting: mockSeedFromExisting,
  }),
}));

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false, joinPod: mockJoinPod }),
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'human-1', username: 'new-human' } }),
}));

const CurrentPath = () => <div data-testid="current-path">{useLocation().pathname}</div>;

const makePod = (id: string, memberIds: string[]) => ({
  _id: id,
  name: id === COMMUNITY_POD_ID ? 'Commonly HQ' : 'My Workspace',
  type: 'team',
  members: memberIds.map((_id) => ({ _id, username: _id, isBot: false })),
  createdAt: '2026-07-21T12:00:00.000Z',
  updatedAt: '2026-07-21T12:00:00.000Z',
});

const renderSidebar = (pods) => {
  const podsState = {
    pods,
    loading: false,
    error: null,
    createPod: jest.fn(),
    patchLastMessage: jest.fn(),
  };
  return render(
    <MemoryRouter initialEntries={['/v2/pods/workspace']}>
      <V2PodsSidebar selectedPodId="workspace" podsState={podsState} />
      <CurrentPath />
    </MemoryRouter>,
  );
};

describe('V2PodsSidebar Community offer', () => {
  const originalCommunityPodId = process.env.REACT_APP_COMMUNITY_POD_ID;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REACT_APP_COMMUNITY_POD_ID = COMMUNITY_POD_ID;
  });

  afterAll(() => {
    if (originalCommunityPodId === undefined) {
      delete process.env.REACT_APP_COMMUNITY_POD_ID;
    } else {
      process.env.REACT_APP_COMMUNITY_POD_ID = originalCommunityPodId;
    }
  });

  test('shows for a configured Community pod the human has not joined and navigates to the redirect', () => {
    renderSidebar([makePod('workspace', ['human-1'])]);

    expect(screen.getByText('Meet the builders and their agents.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Join HQ' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/community');
  });

  test('stays hidden once the Community pod is in memberPodIds', () => {
    renderSidebar([
      makePod('workspace', ['human-1']),
      makePod(COMMUNITY_POD_ID, ['human-1']),
    ]);

    expect(screen.queryByRole('button', { name: 'Join HQ' })).not.toBeInTheDocument();
  });

  test('stays hidden for self-hosted instances without Community config', () => {
    delete process.env.REACT_APP_COMMUNITY_POD_ID;
    renderSidebar([makePod('workspace', ['human-1'])]);

    expect(screen.queryByRole('button', { name: 'Join HQ' })).not.toBeInTheDocument();
  });
});
