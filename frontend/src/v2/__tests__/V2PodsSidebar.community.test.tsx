// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import i18n, { i18nReady } from '../../i18n';
import V2PodsSidebar from '../components/V2PodsSidebar';

const COMMUNITY_POD_ID = 'community-pod';
const mockJoinPod = jest.fn();
const mockSeedFromExisting = jest.fn();
const mockApiGet = jest.fn();
const mockApi = {
  get: mockApiGet,
  post: jest.fn(),
  patch: jest.fn(),
  del: jest.fn(),
};

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

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => mockApi,
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

const makePod = (id: string, memberIds: string[], overrides = {}) => ({
  _id: id,
  name: id === COMMUNITY_POD_ID ? 'Commonly HQ' : 'My Workspace',
  type: 'team',
  members: memberIds.map((_id) => ({ _id, username: _id, isBot: false })),
  createdAt: '2026-07-21T12:00:00.000Z',
  updatedAt: '2026-07-21T12:00:00.000Z',
  ...overrides,
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

  beforeAll(async () => {
    await i18nReady;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockApiGet.mockResolvedValue([]);
    process.env.REACT_APP_COMMUNITY_POD_ID = COMMUNITY_POD_ID;
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  afterAll(async () => {
    if (originalCommunityPodId === undefined) {
      delete process.env.REACT_APP_COMMUNITY_POD_ID;
    } else {
      process.env.REACT_APP_COMMUNITY_POD_ID = originalCommunityPodId;
    }
    await i18n.changeLanguage('en');
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

  test('Community shows public discovery and HQ, excludes personal pods, and leaves All personal', async () => {
    mockApiGet.mockResolvedValue([
      makePod('public-space', [], { name: 'Open Builders', publicRead: true }),
      makePod(COMMUNITY_POD_ID, [], { publicRead: true }),
      makePod('forced-public-dm', [], {
        name: 'Private agent room',
        type: 'agent-room',
        publicRead: true,
      }),
    ]);
    renderSidebar([makePod('workspace', ['human-1'])]);

    fireEvent.click(screen.getByRole('button', { name: 'Community' }));
    expect(await screen.findByText('Open Builders')).toBeInTheDocument();
    expect(screen.getByText('Commonly HQ')).toBeInTheDocument();
    expect(screen.queryByText('Private agent room')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('My Workspace')).toBeInTheDocument();
    expect(screen.queryByText('Open Builders')).not.toBeInTheDocument();
    expect(screen.queryByText('Commonly HQ')).not.toBeInTheDocument();
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledWith('/api/pods?scope=community'));
  });

  test('renders the Community tab from both locale catalogs', async () => {
    renderSidebar([makePod('workspace', ['human-1'])]);
    expect(screen.getByRole('button', { name: 'Community' })).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
    expect(screen.getByRole('button', { name: '社区' })).toBeInTheDocument();
  });
});
